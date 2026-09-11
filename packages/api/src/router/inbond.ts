/** In-bond monitor and external shipments (0026). */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, ilike, or, schema, sql } from "@corridor/db";
import { containsPattern } from "../infra/like";
import {
  externalShipmentInput,
  externalShipmentListInput,
  externalShipmentPatch,
  inBondActionInput,
  inBondListInput,
  inBondNoteInput,
  inBondRecordInput,
  inBondRecordPatch,
  uuid,
} from "@corridor/domain";
import { permissionProcedure, router, type OrgContext } from "../trpc";
import { writeAudit } from "../services/audit";
import { mapDbError } from "../services/db-errors";
import {
  addInBondEvent,
  listInBondRecords,
  requestInBondStatus,
  requireInBondRecord,
  sendInBond,
} from "../services/inbond";

const { inBondRecords, inBondEvents, externalShipments, shipments, userProfiles } = schema;
const actorOf = (ctx: OrgContext) => ({ orgId: ctx.orgId, userId: ctx.session.user.id });

export const inbondRouter = router({
  records: router({
    list: permissionProcedure("inbond.read")
      .input(inBondListInput)
      .query(({ ctx, input }) => ctx.rls((tx) => listInBondRecords(tx, ctx.orgId, input))),

    events: permissionProcedure("inbond.read")
      .input(z.object({ id: uuid }))
      .query(({ ctx, input }) =>
        ctx.rls((tx) =>
          tx
            .select({
              id: inBondEvents.id,
              kind: inBondEvents.kind,
              actorType: inBondEvents.actorType,
              actorName: userProfiles.displayName,
              payload: inBondEvents.payload,
              occurredAt: inBondEvents.occurredAt,
            })
            .from(inBondEvents)
            .leftJoin(userProfiles, eq(userProfiles.userId, inBondEvents.actorId))
            .where(and(eq(inBondEvents.inBondRecordId, input.id), eq(inBondEvents.organizationId, ctx.orgId)))
            .orderBy(desc(inBondEvents.occurredAt)),
        ),
      ),

    create: permissionProcedure("inbond.write")
      .input(inBondRecordInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          if (input.shipmentId) {
            const [s] = await tx
              .select({ id: shipments.id })
              .from(shipments)
              .where(and(eq(shipments.id, input.shipmentId), eq(shipments.organizationId, ctx.orgId)))
              .limit(1);
            if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Shipment not found" });
          }
          if (input.externalShipmentId) {
            const [x] = await tx
              .select({ id: externalShipments.id })
              .from(externalShipments)
              .where(and(eq(externalShipments.id, input.externalShipmentId), eq(externalShipments.organizationId, ctx.orgId)))
              .limit(1);
            if (!x) throw new TRPCError({ code: "NOT_FOUND", message: "External shipment not found" });
          }
          const [row] = await tx
            .insert(inBondRecords)
            .values({
              organizationId: ctx.orgId,
              shipmentId: input.shipmentId ?? null,
              externalShipmentId: input.externalShipmentId ?? null,
              bondNumber: input.bondNumber ?? null,
              entryType: input.entryType,
              arrivalPortId: input.arrivalPortId ?? null,
              exportPortId: input.exportPortId ?? null,
              firmsCode: input.firmsCode ?? null,
              createdBy: ctx.session.user.id,
            })
            .returning()
            .catch((e: unknown) => {
              if ((e as { cause?: { code?: string } })?.cause?.code === "23505")
                throw new TRPCError({ code: "CONFLICT", message: "That shipment already has an in-bond record" });
              throw e;
            });
          await writeAudit(tx, ctx.orgId, "inbond.record_create", "in_bond_record", row!.id, null, row!);
          return row!;
        }),
      ),

    update: permissionProcedure("inbond.write")
      .input(inBondRecordPatch)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const { id, ...patch } = input;
          const before = await requireInBondRecord(tx, ctx.orgId, id);
          const set: Partial<typeof inBondRecords.$inferInsert> = {};
          for (const [k, v] of Object.entries(patch)) if (v !== undefined) (set as Record<string, unknown>)[k] = v;
          const [row] = await tx
            .update(inBondRecords)
            .set(set)
            .where(eq(inBondRecords.id, id))
            .returning()
            .catch(mapDbError);
          await writeAudit(tx, ctx.orgId, "inbond.record_update", "in_bond_record", id, before, row!);
          return row!;
        }),
      ),

    sendArrival: permissionProcedure("inbond.write")
      .input(inBondActionInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const r = await sendInBond(tx, actorOf(ctx), input.id, "arrival");
          await writeAudit(tx, ctx.orgId, "inbond.send_arrival", "in_bond_record", input.id, null, { referenceNumber: r.referenceNumber });
          return r;
        }),
      ),
    sendExport: permissionProcedure("inbond.write")
      .input(inBondActionInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const r = await sendInBond(tx, actorOf(ctx), input.id, "export");
          await writeAudit(tx, ctx.orgId, "inbond.send_export", "in_bond_record", input.id, null, { referenceNumber: r.referenceNumber });
          return r;
        }),
      ),
    cancel: permissionProcedure("inbond.write")
      .input(inBondActionInput.extend({ reason: z.string().trim().max(500).optional() }))
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const r = await sendInBond(tx, actorOf(ctx), input.id, "cancel", input.reason ?? null);
          await writeAudit(tx, ctx.orgId, "inbond.cancel", "in_bond_record", input.id, null, { referenceNumber: r.referenceNumber, reason: input.reason ?? null });
          return r;
        }),
      ),
    requestStatus: permissionProcedure("inbond.write")
      .input(inBondActionInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const r = await requestInBondStatus(tx, actorOf(ctx), input.id);
          await writeAudit(tx, ctx.orgId, "inbond.request_status", "in_bond_record", input.id, null, { status: r.status.status, changed: r.changed });
          return r;
        }),
      ),
    addNote: permissionProcedure("inbond.write")
      .input(inBondNoteInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          await requireInBondRecord(tx, ctx.orgId, input.id);
          await addInBondEvent(tx, actorOf(ctx), input.id, { kind: "note", actorType: "user", payload: { body: input.body } });
          await writeAudit(tx, ctx.orgId, "inbond.note_add", "in_bond_record", input.id, null, { body: input.body });
          return { ok: true };
        }),
      ),
  }),

  external: router({
    list: permissionProcedure("inbond.read")
      .input(externalShipmentListInput)
      .query(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const conds = [eq(externalShipments.organizationId, ctx.orgId)];
          if (input.status) conds.push(eq(externalShipments.status, input.status));
          if (input.q) {
            const like = containsPattern(input.q);
            conds.push(
              or(
                ilike(externalShipments.controlNumber, like),
                ilike(externalShipments.inBondNumber, like),
                ilike(externalShipments.description, like),
              )!,
            );
          }
          const where = and(...conds);
          const [rows, counts] = await Promise.all([
            tx
              .select({
                external: externalShipments,
                recordId: inBondRecords.id,
                recordStatus: inBondRecords.status,
              })
              .from(externalShipments)
              .leftJoin(inBondRecords, eq(inBondRecords.externalShipmentId, externalShipments.id))
              .where(where)
              .orderBy(desc(externalShipments.updatedAt))
              .limit(input.limit)
              .offset(input.offset),
            tx.select({ count: sql<number>`count(*)::int` }).from(externalShipments).where(where),
          ]);
          return {
            rows: rows.map(({ external, recordId, recordStatus }) => ({ ...external, recordId, recordStatus })),
            total: counts[0]?.count ?? 0,
          };
        }),
      ),

    create: permissionProcedure("inbond.write")
      .input(externalShipmentInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const [row] = await tx
            .insert(externalShipments)
            .values({
              organizationId: ctx.orgId,
              regime: input.regime,
              controlNumber: input.controlNumber ?? null,
              inBondNumber: input.inBondNumber ?? null,
              originatingCarrierCode: input.originatingCarrierCode ?? null,
              description: input.description ?? null,
              createdBy: ctx.session.user.id,
            })
            .returning();
          await writeAudit(tx, ctx.orgId, "inbond.external_create", "external_shipment", row!.id, null, row!);
          return row!;
        }),
      ),

    update: permissionProcedure("inbond.write")
      .input(externalShipmentPatch)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const { id, ...patch } = input;
          const [before] = await tx
            .select()
            .from(externalShipments)
            .where(and(eq(externalShipments.id, id), eq(externalShipments.organizationId, ctx.orgId)))
            .limit(1);
          if (!before) throw new TRPCError({ code: "NOT_FOUND" });
          const set: Partial<typeof externalShipments.$inferInsert> = {};
          for (const [k, v] of Object.entries(patch)) if (v !== undefined) (set as Record<string, unknown>)[k] = v;
          const [row] = await tx
            .update(externalShipments)
            .set(set)
            .where(eq(externalShipments.id, id))
            .returning()
            .catch((e: unknown) => {
              if ((e as { cause?: { code?: string } })?.cause?.code === "23514")
                throw new TRPCError({ code: "BAD_REQUEST", message: "A control number or an in-bond number is required" });
              throw e;
            });
          await writeAudit(tx, ctx.orgId, "inbond.external_update", "external_shipment", id, before, row!);
          return row!;
        }),
      ),

    close: permissionProcedure("inbond.write")
      .input(z.object({ id: uuid, reopen: z.boolean().default(false) }))
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const [row] = await tx
            .update(externalShipments)
            .set({ status: input.reopen ? "open" : "closed" })
            .where(and(eq(externalShipments.id, input.id), eq(externalShipments.organizationId, ctx.orgId)))
            .returning();
          if (!row) throw new TRPCError({ code: "NOT_FOUND" });
          await writeAudit(tx, ctx.orgId, "inbond.external_close", "external_shipment", input.id, null, { status: row.status });
          return row;
        }),
      ),
  }),
});
