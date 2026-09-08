/**
 * Movement lifecycle primitives shared by the tRPC router (user session) and
 * background workers (service role, no session). Every status change goes
 * through `applyTransition` so the domain state machine, actor gating and the
 * append-only timeline can never be bypassed.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, schema, type RlsTransaction } from "@corridor/db";
import type { CustomsEventMessage, CustomsShipmentMessage } from "@corridor/integrations";
import { platesFor, trailersForMovement } from "./equipment";
import { shipmentsForMovement } from "./shipments";
import {
  actorMayTransition,
  cascadedShipmentStatus,
  transition,
  validateForTransmit,
  type ActorType,
  type CustomsEventPayload,
  type MovementStatus,
  type ShipmentStatus,
} from "@corridor/domain";

const {
  movements,
  movementCrew,
  movementEvents,
  movementAmendments,
  seals,
  shipments,
  parsRnsEvents,
  drivers,
  driverDocuments,
  trucks,
  userProfiles,
  organizations,
  ports,
} = schema;

export type Tx = RlsTransaction;

/** Who is acting. `userId` is null for system / customs / AI actors. */
export interface Actor {
  orgId: string;
  userId: string | null;
}

export async function requireMovement(tx: Tx, orgId: string, id: string) {
  const [m] = await tx
    .select()
    .from(movements)
    .where(and(eq(movements.id, id), eq(movements.organizationId, orgId)))
    .limit(1);
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Movement not found" });
  return m;
}

export async function addEvent(
  tx: Tx,
  actor: Actor,
  movementId: string,
  e: {
    eventType:
      | "status_change"
      | "amendment"
      | "note"
      | "customs_response"
      | "ai_flag"
      | "customs_event";
    fromStatus?: MovementStatus | null;
    /** Defaults to now; a gateway message carries its own time. */
    occurredAt?: Date;
    toStatus?: MovementStatus | null;
    payload?: Record<string, unknown>;
    actorType: ActorType;
    /** The shipment this row is about, when it is about one. */
    shipmentId?: string | null;
  },
) {
  await tx.insert(movementEvents).values({
    movementId,
    organizationId: actor.orgId,
    shipmentId: e.shipmentId ?? null,
    eventType: e.eventType,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    payload: e.payload ?? null,
    actorType: e.actorType,
    actorId: e.actorType === "user" ? actor.userId : null,
    ...(e.occurredAt && { occurredAt: e.occurredAt }),
  });
}

/** The lifecycle timestamp a shipment status carries, if any. */
const SHIPMENT_STAMP: Partial<Record<ShipmentStatus, "entryOnFileAt" | "releasedAt" | "arrivedAt" | "cancelledAt">> = {
  entry_on_file: "entryOnFileAt",
  released: "releasedAt",
  arrived: "arrivedAt",
  cancelled: "cancelledAt",
};

/**
 * Fan a customs decision out to the shipments riding the movement (0022):
 * every gateway message becomes a `customs_event` timeline row (linked to its
 * shipment when it names one), entry numbers land on the shipment, and each
 * shipment's status follows the decision as far as its own state machine
 * allows. Shipments the gateway did not mention still cascade.
 */
async function applyShipmentOutcomes(
  tx: Tx,
  actor: Actor,
  m: typeof movements.$inferSelect,
  decision: "accepted" | "rejected" | "released" | "held",
  events: CustomsEventMessage[],
  outcomes: CustomsShipmentMessage[],
) {
  const attached = await tx
    .select({
      id: shipments.id,
      controlNumber: shipments.controlNumber,
      status: shipments.status,
      entryNumber: shipments.entryNumber,
    })
    .from(shipments)
    .where(eq(shipments.movementId, m.id));
  const byControl = new Map(attached.map((s) => [s.controlNumber, s]));

  const portIdFor = async (code: string | null | undefined) => {
    if (!code) return null;
    const [port] = await tx
      .select({ id: ports.id })
      .from(ports)
      .where(and(eq(ports.regime, m.regime), eq(ports.code, code)))
      .limit(1);
    return port?.id ?? null;
  };

  for (const e of events) {
    const target = e.shipmentControlNumber ? byControl.get(e.shipmentControlNumber) : undefined;
    // An ACI release carries CBSA's RNS fields: keep them on the PARS RNS feed (0027).
    const rns = (e.raw ?? {}) as Record<string, unknown>;
    if (m.regime === "ACI" && rns.rns === true && e.shipmentControlNumber) {
      await tx.insert(parsRnsEvents).values({
        organizationId: actor.orgId,
        shipmentId: target?.id ?? null,
        parsNumber: e.shipmentControlNumber,
        releaseCode: typeof rns.releaseCode === "string" ? rns.releaseCode : null,
        releasedAt: typeof rns.releasedAt === "string" ? new Date(rns.releasedAt) : new Date(e.occurredAt),
        officeCode: typeof rns.officeCode === "string" ? rns.officeCode : (e.entryPortCode ?? null),
        sublocationCode: typeof rns.sublocationCode === "string" ? rns.sublocationCode : null,
        transactionNumber: typeof rns.transactionNumber === "string" ? rns.transactionNumber : null,
        containerNumber: typeof rns.containerNumber === "string" ? rns.containerNumber : null,
        raw: rns,
      });
    }
    const payload: CustomsEventPayload = {
      code: e.code,
      label: e.label,
      referenceNumber: e.referenceNumber ?? null,
      entryNumber: e.entryNumber ?? null,
      entryPortCode: e.entryPortCode ?? null,
      shipmentControlNumber: e.shipmentControlNumber ?? null,
      occurredAt: e.occurredAt,
      ...(e.raw && { raw: e.raw }),
    };
    await addEvent(tx, actor, m.id, {
      eventType: "customs_event",
      actorType: "customs_api",
      shipmentId: target?.id ?? null,
      payload,
      occurredAt: new Date(e.occurredAt),
    });
  }

  const mentioned = new Map(outcomes.map((o) => [o.controlNumber, o]));
  const hadAllEntries = attached.length > 0 && attached.every((s) => !!s.entryNumber);
  let entries = 0;
  for (const s of attached) {
    const o = mentioned.get(s.controlNumber);
    // A shipment the gateway placed on entry first, then released, passes
    // through entry_on_file so that timestamp is stamped too.
    const steps: ShipmentStatus[] = [];
    if (o?.entryNumber && s.status === "accepted" && o.status !== "held")
      steps.push("entry_on_file");
    steps.push(o?.status ?? decision);
    const set: Partial<typeof shipments.$inferInsert> = {};
    let current = s.status;
    for (const step of steps) {
      const next = cascadedShipmentStatus(current, step);
      if (!next) continue;
      current = next;
      set.status = next;
      const stamp = SHIPMENT_STAMP[next];
      if (stamp) set[stamp] = new Date();
    }
    if (o?.entryNumber) {
      set.entryNumber = o.entryNumber;
      set.entryPortId = (await portIdFor(o.entryPortCode)) ?? undefined;
    }
    if (o?.entryNumber || s.entryNumber) entries += 1;
    if (Object.keys(set).length > 0)
      await tx.update(shipments).set(set).where(eq(shipments.id, s.id));
  }
  const allEntries = attached.length > 0 && entries === attached.length;
  if (allEntries && !hadAllEntries) {
    const { notifyOrganization } = await import("./notifications");
    await notifyOrganization(tx, {
      orgId: actor.orgId,
      eventType: "shipment.entry_on_file",
      title: `${m.movementNumber}: entry numbers on file for every shipment`,
      linkPath: `/movements/${m.id}`,
    });
  }
  return { entriesJustCompleted: allEntries && !hadAllEntries };
}

export async function applyTransition(
  tx: Tx,
  actor: Actor,
  m: typeof movements.$inferSelect,
  to: MovementStatus,
  actorType: ActorType,
  extra: Partial<typeof movements.$inferInsert> = {},
  payload: Record<string, unknown> = {},
) {
  const from = m.status;
  try {
    transition(from, to);
  } catch (e) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: (e as Error).message });
  }
  if (!actorMayTransition(actorType, from, to)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${from} → ${to} can only be driven by customs`,
    });
  }
  const [row] = await tx
    .update(movements)
    .set({ status: to, ...extra })
    .where(eq(movements.id, m.id))
    .returning();
  await addEvent(tx, actor, m.id, {
    eventType: "status_change",
    fromStatus: from,
    toStatus: to,
    payload,
    actorType,
  });
  return row!;
}

/**
 * Record a customs decision (from the mock/real gateway, or the dev
 * simulation) and transition accordingly. Resolves submitted amendments.
 */
export async function applyCustomsDecision(
  tx: Tx,
  actor: Actor,
  m: typeof movements.$inferSelect,
  input: {
    decision: "accepted" | "rejected" | "released" | "held";
    referenceNumber?: string | null;
    message?: string | null;
    simulated?: boolean;
    raw?: Record<string, unknown>;
    /** Gateway messages behind the decision (0022); each becomes a timeline row. */
    events?: CustomsEventMessage[];
    /** Per-shipment outcomes; unmentioned shipments cascade the decision. */
    shipments?: CustomsShipmentMessage[];
  },
) {
  const ref = input.referenceNumber ?? m.customsReferenceNumber ?? null;
  await addEvent(tx, actor, m.id, {
    eventType: "customs_response",
    actorType: "customs_api",
    payload: {
      decision: input.decision,
      referenceNumber: ref,
      message: input.message ?? null,
      simulated: input.simulated ?? false,
      ...(input.raw && { raw: input.raw }),
    },
  });
  const updated = await applyTransition(
    tx,
    actor,
    m,
    input.decision,
    "customs_api",
    ref ? { customsReferenceNumber: ref } : {},
    { referenceNumber: ref, message: input.message ?? null },
  );
  if (input.decision === "accepted" || input.decision === "rejected") {
    await tx
      .update(movementAmendments)
      .set({ status: input.decision })
      .where(
        and(eq(movementAmendments.movementId, m.id), eq(movementAmendments.status, "submitted")),
      );
  }
  const outcomes = await applyShipmentOutcomes(
    tx,
    actor,
    m,
    input.decision,
    input.events ?? [],
    input.shipments ?? [],
  );

  // Driver / dispatch paperwork (0025): the sheet goes out on acceptance, and
  // again once every shipment has its entry number.
  const { enqueueJob } = await import("./jobs");
  if (input.decision === "accepted") {
    await enqueueJob(tx, {
      orgId: actor.orgId,
      jobType: "driver.notify",
      payload: { movementId: m.id, trigger: "accepted" },
      maxAttempts: 2,
    });
  }
  if (outcomes.entriesJustCompleted) {
    await enqueueJob(tx, {
      orgId: actor.orgId,
      jobType: "driver.notify",
      payload: { movementId: m.id, trigger: "entries_complete" },
      maxAttempts: 2,
    });
  }

  // Dynamic import: notifications.ts -> customs.ts -> movements.ts would otherwise cycle.
  const { notifyOrganization } = await import("./notifications");
  const decisionLabel = {
    accepted: "accepted",
    rejected: "rejected",
    released: "released",
    held: "held for inspection",
  }[input.decision];
  await notifyOrganization(tx, {
    orgId: actor.orgId,
    eventType: "customs.decision",
    title: `${m.movementNumber} ${decisionLabel} by ${m.regime === "ACE" ? "CBP" : "CBSA"}`,
    body: input.message ?? undefined,
    linkPath: `/movements/${m.id}`,
  });
  if (input.decision === "accepted") {
    await notifyOrganization(tx, {
      orgId: actor.orgId,
      eventType: "movement.accepted",
      title: `${m.movementNumber} accepted — driver sheet on its way to dispatch`,
      linkPath: `/movements/${m.id}`,
    });
  }

  return updated;
}

/**
 * The crew of one movement, each person's registry record and travel documents
 * folded in. Ordered the way the manifest prints them: person in charge first.
 */
export async function crewForMovement(tx: Tx, movementId: string) {
  const rows = await tx
    .select({
      id: movementCrew.id,
      driverId: movementCrew.driverId,
      role: movementCrew.role,
      position: movementCrew.position,
      firstName: drivers.firstName,
      lastName: drivers.lastName,
      personType: drivers.personType,
      gender: drivers.gender,
      licenseNumber: drivers.licenseNumber,
      licenseJurisdiction: drivers.licenseJurisdiction,
      licenseExpiry: drivers.licenseExpiry,
      citizenship: drivers.citizenship,
      dateOfBirth: drivers.dateOfBirth,
      hazmatEndorsement: drivers.hazmatEndorsement,
      usAddress: drivers.usAddress,
      status: drivers.status,
    })
    .from(movementCrew)
    .innerJoin(drivers, eq(drivers.id, movementCrew.driverId))
    .where(eq(movementCrew.movementId, movementId))
    .orderBy(asc(movementCrew.position), asc(drivers.lastName));

  const documents = rows.length
    ? await tx
        .select()
        .from(driverDocuments)
        .where(
          inArray(
            driverDocuments.driverId,
            rows.map((r) => r.driverId),
          ),
        )
        .orderBy(desc(driverDocuments.isPrimary), asc(driverDocuments.documentType))
    : [];

  const roleRank = { person_in_charge: 0, crew_member: 1, passenger: 2 };
  return rows
    .map((r) => ({ ...r, documents: documents.filter((d) => d.driverId === r.driverId) }))
    .sort((a, b) => roleRank[a.role] - roleRank[b.role] || a.position - b.position);
}

export async function loadFull(tx: Tx, orgId: string, id: string) {
  const m = await requireMovement(tx, orgId, id);
  const [crew, truck, trailerRows, port, shipmentRows, sealRows, events, amendments] =
    await Promise.all([
      crewForMovement(tx, id),
      m.truckId
        ? tx
            .select()
            .from(trucks)
            .where(eq(trucks.id, m.truckId))
            .then((r) => r[0] ?? null)
            .then(async (t) =>
              t ? { ...t, plates: await platesFor(tx, { truckIds: [t.id] }) } : null,
            )
        : null,
      trailersForMovement(tx, id),
      m.portId
        ? tx
            .select()
            .from(ports)
            .where(eq(ports.id, m.portId))
            .then((r) => r[0] ?? null)
        : null,
      shipmentsForMovement(tx, id),
      tx.select().from(seals).where(eq(seals.movementId, id)).orderBy(asc(seals.createdAt)),
      tx
        .select({
          id: movementEvents.id,
          eventType: movementEvents.eventType,
          fromStatus: movementEvents.fromStatus,
          toStatus: movementEvents.toStatus,
          payload: movementEvents.payload,
          actorType: movementEvents.actorType,
          actorId: movementEvents.actorId,
          actorName: userProfiles.displayName,
          occurredAt: movementEvents.occurredAt,
        })
        .from(movementEvents)
        .leftJoin(userProfiles, eq(userProfiles.userId, movementEvents.actorId))
        .where(eq(movementEvents.movementId, id))
        .orderBy(desc(movementEvents.occurredAt)),
      tx
        .select()
        .from(movementAmendments)
        .where(eq(movementAmendments.movementId, id))
        .orderBy(desc(movementAmendments.amendmentNumber)),
    ]);

  return {
    ...m,
    crew,
    truck,
    /** In tow order, each with its plates and seals (0021). */
    trailers: trailerRows,
    port,
    shipments: shipmentRows,
    /** Every seal on the movement; `movementTrailerId` null = on the truck. */
    seals: sealRows,
    events,
    amendments,
  };
}

export type FullMovement = Awaited<ReturnType<typeof loadFull>>;

export function validationFor(full: FullMovement) {
  return validateForTransmit({
    regime: full.regime,
    port: full.port ? { code: full.port.code } : null,
    carrierCode: full.carrierCode,
    scheduledCrossingAt: full.scheduledCrossingAt?.toISOString() ?? null,
    crew: full.crew.map((c) => ({
      role: c.role,
      personType: c.personType,
      displayName: `${c.firstName} ${c.lastName}`,
      licenseExpiry: c.licenseExpiry,
      status: c.status,
      citizenship: c.citizenship,
      usAddress: c.usAddress,
      documents: c.documents.map((d) => ({
        documentType: d.documentType,
        expiresOn: d.expiresOn,
      })),
    })),
    truck: full.truck
      ? {
          registrationExpiry: full.truck.registrationExpiry,
          insuranceExpiry: full.truck.insuranceExpiry,
          plateNumber: full.truck.plateNumber,
          status: full.truck.status,
        }
      : null,
    isEmpty: full.isEmpty,
    aciInTransit: full.aciInTransit,
    trailers: full.trailers.map((t) => ({
      unitNumber: t.unitNumber,
      registrationExpiry: t.registrationExpiry,
      plateNumber: t.plateNumber,
      status: t.status,
      sealCount: t.seals.length,
    })),
    shipments: full.shipments.map((s) => ({
      controlNumber: s.controlNumber,
      shipmentType: s.shipmentType,
      cargoType: s.cargoType,
      shipper: s.shipperName ? { name: s.shipperName, country: s.shipperCountry } : null,
      consignee: s.consigneeName ? { name: s.consigneeName, country: s.consigneeCountry } : null,
      entryNumber: s.entryNumber,
      inBondEntryType: s.inBondEntryType,
      inBondDestinationPortId: s.inBondDestinationPortId,
      destinationPortId: s.destinationPortId,
      commodities: s.commodities.map((c) => ({
        commodityDescription: c.commodityDescription,
        hsCode: c.hsCode,
        weightKg: c.weightKg,
        quantity: c.quantity,
        quantityUnit: c.quantityUnit,
        valueAmount: c.valueAmount,
        valueCurrency: c.valueCurrency,
        countryOfOrigin: c.countryOfOrigin,
      })),
    })),
    seals: full.seals.map((s) => ({ sealNumber: s.sealNumber })),
  });
}

export async function loadOrganization(tx: Tx, orgId: string) {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found" });
  return org;
}
