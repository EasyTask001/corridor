/**
 * In-bond moves (0026): a bond's arrival at the port, its export and its
 * cancellation are messages of their own, sent days after the manifest.
 * Every send logs an integration_events row, a customs_submissions row
 * (kind in_bond) and an in_bond_events row, then moves the record along
 * IN_BOND_TRANSITIONS.
 */
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, ilike, inArray, or, schema, sql, type RlsTransaction } from "@corridor/db";
import { containsPattern } from "../infra/like";
import {
  canTransitionInBond,
  inBondSendable,
  type InBondEventKind,
  type InBondListInput,
  type InBondStatus,
} from "@corridor/domain";
import {
  CustomsTransportError,
  type InBondMessage,
  type InBondStatusMessage,
} from "@corridor/integrations";
import {
  customsClientFor,
  logIntegrationEvent,
  recordSubmission,
  requireCustomsCapability,
} from "./customs";
import type { Actor } from "./movements";

const { inBondRecords, inBondEvents, externalShipments, shipments, ports } = schema;

export type InBondRecord = typeof inBondRecords.$inferSelect;

export async function requireInBondRecord(tx: RlsTransaction, orgId: string, id: string) {
  const [r] = await tx
    .select()
    .from(inBondRecords)
    .where(and(eq(inBondRecords.id, id), eq(inBondRecords.organizationId, orgId)))
    .limit(1);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "In-bond record not found" });
  return r;
}

export async function addInBondEvent(
  tx: RlsTransaction,
  actor: Actor,
  recordId: string,
  e: {
    kind: InBondEventKind;
    actorType: "user" | "system" | "customs_api";
    payload?: Record<string, unknown>;
  },
) {
  await tx.insert(inBondEvents).values({
    organizationId: actor.orgId,
    inBondRecordId: recordId,
    kind: e.kind,
    actorType: e.actorType,
    actorId: e.actorType === "user" ? actor.userId : null,
    payload: e.payload ?? null,
  });
}

/** The monitor row: record + what it is about + the port codes. */
export async function listInBondRecords(tx: RlsTransaction, orgId: string, input: InBondListInput) {
  const arrival = sql<
    string | null
  >`(select code from public.ports p where p.id = ${inBondRecords.arrivalPortId})`;
  const exportCode = sql<
    string | null
  >`(select code from public.ports p where p.id = ${inBondRecords.exportPortId})`;
  const conds = [eq(inBondRecords.organizationId, orgId)];
  if (input.status?.length) conds.push(inArray(inBondRecords.status, input.status));
  if (input.q) {
    const like = containsPattern(input.q);
    conds.push(
      or(
        ilike(inBondRecords.bondNumber, like),
        ilike(shipments.controlNumber, like),
        ilike(externalShipments.controlNumber, like),
        ilike(externalShipments.inBondNumber, like),
      )!,
    );
  }
  const where = and(...conds);
  const [rows, counts] = await Promise.all([
    tx
      .select({
        record: inBondRecords,
        shipmentControlNumber: shipments.controlNumber,
        shipmentRegime: shipments.regime,
        shipmentMovementId: shipments.movementId,
        externalControlNumber: externalShipments.controlNumber,
        externalInBondNumber: externalShipments.inBondNumber,
        externalRegime: externalShipments.regime,
        externalCarrier: externalShipments.originatingCarrierCode,
        arrivalPortCode: arrival,
        exportPortCode: exportCode,
      })
      .from(inBondRecords)
      .leftJoin(shipments, eq(shipments.id, inBondRecords.shipmentId))
      .leftJoin(externalShipments, eq(externalShipments.id, inBondRecords.externalShipmentId))
      .where(where)
      .orderBy(desc(inBondRecords.updatedAt))
      .limit(input.limit)
      .offset(input.offset),
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(inBondRecords)
      .leftJoin(shipments, eq(shipments.id, inBondRecords.shipmentId))
      .leftJoin(externalShipments, eq(externalShipments.id, inBondRecords.externalShipmentId))
      .where(where),
  ]);
  return {
    rows: rows.map(({ record, ...rest }) => ({
      ...record,
      regime: rest.shipmentRegime ?? rest.externalRegime ?? "ACE",
      controlNumber:
        rest.shipmentControlNumber ?? rest.externalControlNumber ?? rest.externalInBondNumber,
      movementId: rest.shipmentMovementId,
      external: !!record.externalShipmentId,
      originatingCarrierCode: rest.externalCarrier,
      arrivalPortCode: rest.arrivalPortCode,
      exportPortCode: rest.exportPortCode,
    })),
    total: counts[0]?.count ?? 0,
  };
}

/** What the gateway is told about a move: fails with the missing fields spelled out. */
async function messageFor(
  tx: RlsTransaction,
  orgId: string,
  r: InBondRecord,
): Promise<{ regime: "ACE" | "ACI"; message: InBondMessage }> {
  const parsed = inBondSendable.safeParse({
    bondNumber: r.bondNumber,
    arrivalPortId: r.arrivalPortId,
    exportPortId: r.exportPortId,
    firmsCode: r.firmsCode,
  });
  if (!parsed.success) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Cannot send: ${parsed.error.issues.map((i) => `${i.path.join(".")} — ${i.message}`).join("; ")}`,
    });
  }
  const [arrival, exportPort] = await Promise.all([
    tx
      .select({ code: ports.code })
      .from(ports)
      .where(eq(ports.id, parsed.data.arrivalPortId))
      .then((x) => x[0]),
    tx
      .select({ code: ports.code })
      .from(ports)
      .where(eq(ports.id, parsed.data.exportPortId))
      .then((x) => x[0]),
  ]);
  if (!arrival || !exportPort)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Arrival or export port is unknown",
    });

  let regime: "ACE" | "ACI" = "ACE";
  let carrierCode: string | null = null;
  let controlNumber: string | null = null;
  if (r.shipmentId) {
    const [s] = await tx
      .select({
        regime: shipments.regime,
        carrierCode: shipments.carrierCode,
        controlNumber: shipments.controlNumber,
      })
      .from(shipments)
      .where(and(eq(shipments.id, r.shipmentId), eq(shipments.organizationId, orgId)))
      .limit(1);
    if (s) ({ regime, carrierCode, controlNumber } = s);
  } else if (r.externalShipmentId) {
    const [x] = await tx
      .select({
        regime: externalShipments.regime,
        carrierCode: externalShipments.originatingCarrierCode,
        controlNumber: externalShipments.controlNumber,
      })
      .from(externalShipments)
      .where(
        and(
          eq(externalShipments.id, r.externalShipmentId),
          eq(externalShipments.organizationId, orgId),
        ),
      )
      .limit(1);
    if (x) ({ regime, carrierCode, controlNumber } = x);
  }
  return {
    regime,
    message: {
      bondNumber: parsed.data.bondNumber,
      entryType: r.entryType,
      arrivalPortCode: arrival.code,
      exportPortCode: exportPort.code,
      firmsCode: parsed.data.firmsCode,
      carrierCode,
      controlNumber,
    },
  };
}

async function regimeFor(
  tx: RlsTransaction,
  orgId: string,
  r: InBondRecord,
): Promise<"ACE" | "ACI"> {
  if (r.shipmentId) {
    const [s] = await tx
      .select({ regime: shipments.regime })
      .from(shipments)
      .where(and(eq(shipments.id, r.shipmentId), eq(shipments.organizationId, orgId)))
      .limit(1);
    if (s) return s.regime;
  }
  if (r.externalShipmentId) {
    const [x] = await tx
      .select({ regime: externalShipments.regime })
      .from(externalShipments)
      .where(
        and(
          eq(externalShipments.id, r.externalShipmentId),
          eq(externalShipments.organizationId, orgId),
        ),
      )
      .limit(1);
    if (x) return x.regime;
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: "In-bond parent shipment is missing",
  });
}

const ACTION: Record<
  "arrival" | "export" | "cancel",
  { next: InBondStatus; kind: InBondEventKind; op: string }
> = {
  arrival: { next: "arrival_sent", kind: "arrival_sent", op: "in_bond_arrival" },
  export: { next: "export_sent", kind: "export_sent", op: "in_bond_export" },
  cancel: { next: "cancelled", kind: "cancel_sent", op: "in_bond_cancel" },
};

/** Send arrival / export / cancel for one record. Transport failures throw BAD_GATEWAY. */
export async function sendInBond(
  tx: RlsTransaction,
  actor: Actor,
  recordId: string,
  action: "arrival" | "export" | "cancel",
  reason: string | null = null,
) {
  const r = await requireInBondRecord(tx, actor.orgId, recordId);
  const { next, kind, op } = ACTION[action];
  if (!canTransitionInBond(r.status, next)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Cannot send ${action} while the move is ${r.status.replace(/_/g, " ")}`,
    });
  }
  const { regime, message } = await messageFor(tx, actor.orgId, r);
  const { client } = await customsClientFor(tx, actor.orgId, regime);
  requireCustomsCapability(client, "inBond");
  const correlationId = randomUUID();
  const started = Date.now();
  try {
    const ack =
      action === "arrival"
        ? await client.inBondArrival(message)
        : action === "export"
          ? await client.inBondExport(message)
          : await client.inBondCancel(message, reason);
    await logIntegrationEvent(tx, {
      orgId: actor.orgId,
      provider: client.provider,
      direction: "outbound",
      operation: op,
      request: { ...message, reason },
      response: { referenceNumber: ack.referenceNumber, receivedAt: ack.receivedAt, ...ack.raw },
      statusCode: 200,
      success: true,
      durationMs: Date.now() - started,
      correlationId,
    });
    await recordSubmission(tx, {
      orgId: actor.orgId,
      movementId: null,
      kind: "in_bond",
      client,
      referenceNumber: ack.referenceNumber,
      correlationId,
      status: "acknowledged",
      request: { action, ...message, reason },
      response: ack.raw,
    });
    await addInBondEvent(tx, actor, r.id, {
      kind,
      actorType: "user",
      payload: { referenceNumber: ack.referenceNumber, receivedAt: ack.receivedAt, reason },
    });
    const [updated] = await tx
      .update(inBondRecords)
      .set({ status: next })
      .where(eq(inBondRecords.id, r.id))
      .returning();
    return { record: updated!, referenceNumber: ack.referenceNumber };
  } catch (err) {
    if (err instanceof CustomsTransportError) {
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: `${err.message}. The ${action} message was not transmitted.`,
      });
    }
    throw err;
  }
}

const STATUS_FROM_GATEWAY: Partial<Record<InBondStatusMessage["status"], InBondStatus>> = {
  arrived: "arrived",
  exported: "exported",
  cancelled: "cancelled",
};

/** Ask customs where the bond stands; move the record forward when it says so. */
export async function requestInBondStatus(tx: RlsTransaction, actor: Actor, recordId: string) {
  const r = await requireInBondRecord(tx, actor.orgId, recordId);
  if (!r.bondNumber)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No bond number on this record yet",
    });
  const regime = await regimeFor(tx, actor.orgId, r);
  const { client } = await customsClientFor(tx, actor.orgId, regime);
  requireCustomsCapability(client, "inBond");
  const started = Date.now();
  const status = await client.inBondStatus(r.bondNumber);
  await logIntegrationEvent(tx, {
    orgId: actor.orgId,
    provider: client.provider,
    direction: "inbound",
    operation: "in_bond_status",
    request: { bondNumber: r.bondNumber },
    response: { status: status.status, message: status.message },
    statusCode: 200,
    success: true,
    durationMs: Date.now() - started,
  });
  await addInBondEvent(tx, actor, r.id, {
    kind: "status_requested",
    actorType: "user",
    payload: { bondNumber: r.bondNumber },
  });
  await addInBondEvent(tx, actor, r.id, {
    kind: "customs_response",
    actorType: "customs_api",
    payload: { status: status.status, message: status.message, raw: status.raw },
  });
  const target = STATUS_FROM_GATEWAY[status.status];
  const set: Partial<typeof inBondRecords.$inferInsert> = { lastStatusCheckedAt: new Date() };
  let changed = false;
  if (target && target !== r.status && canTransitionInBond(r.status, target)) {
    set.status = target;
    changed = true;
  }
  const [updated] = await tx
    .update(inBondRecords)
    .set(set)
    .where(eq(inBondRecords.id, r.id))
    .returning();
  if (changed) {
    // Dynamic import: notifications.ts -> customs.ts would otherwise cycle.
    const { notifyOrganization } = await import("./notifications");
    await notifyOrganization(tx, {
      orgId: actor.orgId,
      eventType: "customs.decision",
      title: `In-bond ${r.bondNumber} ${target!.replace(/_/g, " ")} — ${regime === "ACE" ? "CBP" : "CBSA"}`,
      body: status.message ?? undefined,
      linkPath: "/in-bond",
    });
  }
  return { record: updated!, status, changed };
}

/** An ACE `in_bond` shipment gets its monitor record on creation (shipment.create). */
export async function ensureInBondRecordForShipment(
  tx: RlsTransaction,
  actor: Actor,
  s: {
    id: string;
    inBondEntryType: "IT" | "TE" | "IE" | null;
    inBondNumber: string | null;
    entryPortId: string | null;
    inBondDestinationPortId: string | null;
  },
) {
  const [existing] = await tx
    .select({ id: inBondRecords.id })
    .from(inBondRecords)
    .where(eq(inBondRecords.shipmentId, s.id))
    .limit(1);
  if (existing) return existing;
  const [row] = await tx
    .insert(inBondRecords)
    .values({
      organizationId: actor.orgId,
      shipmentId: s.id,
      entryType: s.inBondEntryType ?? "IT",
      bondNumber: s.inBondNumber && /^\d{9}$/.test(s.inBondNumber) ? s.inBondNumber : null,
      arrivalPortId: s.entryPortId,
      exportPortId: s.inBondDestinationPortId,
      createdBy: actor.userId,
    })
    .returning({ id: inBondRecords.id });
  await addInBondEvent(tx, actor, row!.id, {
    kind: "note",
    actorType: "system",
    payload: { body: "Record opened from the in-bond shipment." },
  });
  return row!;
}
