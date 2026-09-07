/**
 * Movement lifecycle primitives shared by the tRPC router (user session) and
 * background workers (service role, no session). Every status change goes
 * through `applyTransition` so the domain state machine, actor gating and the
 * append-only timeline can never be bypassed.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, schema, type RlsTransaction } from "@corridor/db";
import { shipmentsForMovement } from "./shipments";
import {
  actorMayTransition,
  transition,
  validateForTransmit,
  type ActorType,
  type MovementStatus,
} from "@corridor/domain";

const {
  movements,
  movementCrew,
  movementEvents,
  movementAmendments,
  seals,
  drivers,
  driverDocuments,
  trucks,
  trailers,
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
    eventType: "status_change" | "amendment" | "note" | "customs_response" | "ai_flag";
    fromStatus?: MovementStatus | null;
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
  });
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
  const [crew, truck, trailer, port, shipmentRows, sealRows, events, amendments] =
    await Promise.all([
      crewForMovement(tx, id),
      m.truckId
        ? tx
            .select()
            .from(trucks)
            .where(eq(trucks.id, m.truckId))
            .then((r) => r[0] ?? null)
        : null,
      m.trailerId
        ? tx
            .select()
            .from(trailers)
            .where(eq(trailers.id, m.trailerId))
            .then((r) => r[0] ?? null)
        : null,
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
    trailer,
    port,
    shipments: shipmentRows,
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
    trailer: full.trailer
      ? {
          registrationExpiry: full.trailer.registrationExpiry,
          plateNumber: full.trailer.plateNumber,
          status: full.trailer.status,
        }
      : null,
    shipments: full.shipments.map((s) => ({
      controlNumber: s.controlNumber,
      shipmentType: s.shipmentType,
      cargoType: s.cargoType,
      shipper: s.shipperName ? { name: s.shipperName, country: s.shipperCountry } : null,
      consignee: s.consigneeName ? { name: s.consigneeName, country: s.consigneeCountry } : null,
      entryNumber: s.entryNumber,
      inBondEntryType: s.inBondEntryType,
      inBondDestinationPortId: s.inBondDestinationPortId,
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
