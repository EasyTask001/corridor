/**
 * Shipments — the customs filing unit. A shipment is created and searched on
 * its own and attached to a movement when it goes on a truck, so this router
 * is deliberately independent of `movement`: only `assign` / `unassign` and
 * the movement-scoped `listForAssign` touch both.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, or, schema, sql } from "@corridor/db";
import { containsPattern } from "../infra/like";
import {
  addressToColumns,
  assignShipmentsInput,
  commodityRemoveInput,
  commodityUpsertInput,
  isEditable,
  nestAddress,
  shipmentInput,
  shipmentBulkRemoveInput,
  shipmentListInput,
  rnsListInput,
  shipmentPatch,
  uuid,
  type Address,
} from "@corridor/domain";
import { permissionProcedure, router } from "../trpc";
import { writeAudit } from "../services/audit";
import { requireMovement } from "../services/movements";
import { syncMovementRiskAlerts } from "../services/risk";
import {
  assertPartnersExist,
  commoditiesFor,
  defaultCarrierCode,
  requireShipment,
  shipmentSetFrom,
  writeHazmat,
} from "../services/shipments";

const { shipments, commodities, movements, partners, ports, parsRnsEvents } = schema;

const shipmentIdsInput = z.object({ shipmentIds: z.array(uuid).min(1).max(100) });

/** A shipment is frozen while the movement carrying it is past draft/rejected. */
async function requireEditableShipment(
  tx: Parameters<typeof requireShipment>[0],
  orgId: string,
  id: string,
) {
  const s = await requireShipment(tx, orgId, id);
  if (s.movementId) {
    const m = await requireMovement(tx, orgId, s.movementId);
    if (!isEditable(m.status)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Shipment cannot be edited while movement ${m.movementNumber} is ${m.status}`,
      });
    }
  }
  return s;
}

export const shipmentRouter = router({
  list: permissionProcedure("shipment.read")
    .input(shipmentListInput)
    .query(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const conds = [eq(shipments.organizationId, ctx.orgId)];
        if (input.regime) conds.push(eq(shipments.regime, input.regime));
        if (input.status?.length) conds.push(inArray(shipments.status, input.status));
        if (input.unassignedOnly) conds.push(isNull(shipments.movementId));
        if (input.q) {
          const like = containsPattern(input.q);
          // Search-by-column (Task 14): one column when named, else every searchable one.
          const byColumn = {
            controlNumber: ilike(shipments.controlNumber, like),
            entryNumber: ilike(shipments.entryNumber, like),
            inBondNumber: ilike(shipments.inBondNumber, like),
            shipperName: sql`exists (select 1 from public.partners p where p.id = ${shipments.shipperId} and p.name ilike ${like})`,
            movementNumber: sql`exists (select 1 from public.movements m where m.id = ${shipments.movementId} and m.movement_number ilike ${like})`,
          };
          conds.push(
            input.searchColumn
              ? byColumn[input.searchColumn]
              : or(byColumn.controlNumber, byColumn.entryNumber, byColumn.inBondNumber)!,
          );
        }
        const where = and(...conds);
        const limit = input.pageSize ?? input.limit;
        const [rows, counts] = await Promise.all([
          tx
            .select({
              id: shipments.id,
              regime: shipments.regime,
              controlNumber: shipments.controlNumber,
              controlReference: shipments.controlReference,
              carrierCode: shipments.carrierCode,
              shipmentType: shipments.shipmentType,
              cargoType: shipments.cargoType,
              status: shipments.status,
              isPars: shipments.isPars,
              entryNumber: shipments.entryNumber,
              movementId: shipments.movementId,
              movementNumber: movements.movementNumber,
              shipperName: partners.name,
              commodityCount: sql<number>`(select count(*)::int from public.commodities c where c.shipment_id = ${shipments.id})`,
              updatedAt: shipments.updatedAt,
            })
            .from(shipments)
            .leftJoin(movements, eq(movements.id, shipments.movementId))
            .leftJoin(partners, eq(partners.id, shipments.shipperId))
            .where(where)
            .orderBy(desc(shipments.updatedAt))
            .limit(limit)
            .offset(input.offset),
          tx
            .select({ count: sql<number>`count(*)::int` })
            .from(shipments)
            .where(where),
        ]);
        return { rows, total: counts[0]?.count ?? 0 };
      }),
    ),

  get: permissionProcedure("shipment.read")
    .input(z.object({ id: uuid }))
    .query(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const s = await requireShipment(tx, ctx.orgId, input.id);
        const portIds = [
          s.entryPortId,
          s.inBondDestinationPortId,
          s.destinationPortId,
          s.sublocationPortId,
        ].filter((id): id is string => !!id);
        const [lines, shipper, consignee, movement, portRows] = await Promise.all([
          commoditiesFor(tx, [s.id]),
          s.shipperId
            ? tx
                .select()
                .from(partners)
                .where(eq(partners.id, s.shipperId))
                .then((r) => r[0] ?? null)
            : null,
          s.consigneeId
            ? tx
                .select()
                .from(partners)
                .where(eq(partners.id, s.consigneeId))
                .then((r) => r[0] ?? null)
            : null,
          s.movementId
            ? tx
                .select({
                  id: movements.id,
                  movementNumber: movements.movementNumber,
                  status: movements.status,
                })
                .from(movements)
                .where(eq(movements.id, s.movementId))
                .then((r) => r[0] ?? null)
            : null,
          portIds.length
            ? tx
                .select({ id: ports.id, code: ports.code, name: ports.name })
                .from(ports)
                .where(inArray(ports.id, portIds))
            : [],
        ]);
        return {
          ...nestAddress("delivery", "deliveryAddress", s),
          commodities: lines,
          shipper: shipper && nestAddress("address", "address", shipper),
          consignee: consignee && nestAddress("address", "address", consignee),
          movement,
          // id -> code/name for the four port columns, so the form's pickers
          // can open showing what is stored.
          ports: Object.fromEntries(portRows.map((p) => [p.id, { code: p.code, name: p.name }])),
        };
      }),
    ),

  create: permissionProcedure("shipment.write")
    .input(shipmentInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const { carrierCode, movementId, deliveryAddress, ...fields } = input as typeof input & {
          deliveryAddress?: Address;
        };
        if (movementId) {
          const m = await requireMovement(tx, ctx.orgId, movementId);
          if (m.regime !== input.regime) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `A ${input.regime} shipment cannot ride a ${m.regime} movement`,
            });
          }
          if (!isEditable(m.status)) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: `Movement cannot be edited while ${m.status}`,
            });
          }
        }
        await assertPartnersExist(tx, ctx.orgId, [
          input.shipperId ?? null,
          input.consigneeId ?? null,
        ]);
        const [row] = await tx
          .insert(shipments)
          .values({
            ...fields,
            ...addressToColumns("delivery", deliveryAddress),
            organizationId: ctx.orgId,
            movementId: movementId ?? null,
            carrierCode: carrierCode ?? (await defaultCarrierCode(tx, ctx.orgId, input.regime)),
          })
          .returning()
          .catch((e: unknown) => {
            if ((e as { cause?: { code?: string } })?.cause?.code === "23505")
              throw new TRPCError({
                code: "CONFLICT",
                message: "A shipment with that control number already exists",
              });
            throw e;
          });
        await writeAudit(tx, ctx.orgId, "shipment.create", "shipment", row!.id, null, row!);
        // An in-bond shipment is watched on the in-bond monitor from day one (0026).
        if (row!.shipmentType === "in_bond") {
          const { ensureInBondRecordForShipment } = await import("../services/inbond");
          await ensureInBondRecordForShipment(
            tx,
            { orgId: ctx.orgId, userId: ctx.session.user.id },
            row!,
          );
        }
        return nestAddress("delivery", "deliveryAddress", row!);
      }),
    ),

  update: permissionProcedure("shipment.write")
    .input(shipmentPatch.extend({ id: uuid }))
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const { id, ...patch } = input;
        const before = await requireEditableShipment(tx, ctx.orgId, id);
        await assertPartnersExist(tx, ctx.orgId, [
          patch.shipperId ?? null,
          patch.consigneeId ?? null,
        ]);
        const [row] = await tx
          .update(shipments)
          .set(shipmentSetFrom(patch))
          .where(eq(shipments.id, id))
          .returning();
        await writeAudit(tx, ctx.orgId, "shipment.update", "shipment", id, before, row!);
        return nestAddress("delivery", "deliveryAddress", row!);
      }),
    ),

  /** Drafts only — anything filed with customs is cancelled, never removed. */
  remove: permissionProcedure("shipment.write")
    .input(z.object({ id: uuid }))
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const s = await requireEditableShipment(tx, ctx.orgId, input.id);
        if (s.status !== "draft") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Only draft shipments can be deleted (this one is ${s.status})`,
          });
        }
        await tx.delete(shipments).where(eq(shipments.id, input.id));
        if (s.movementId) await syncMovementRiskAlerts(tx, ctx.orgId, s.movementId);
        await writeAudit(tx, ctx.orgId, "shipment.remove", "shipment", input.id, s, null);
        return { id: input.id };
      }),
    ),

  /** Bulk delete from the list (Task 14): drafts go, anything else is reported back. */
  bulkRemove: permissionProcedure("shipment.write")
    .input(shipmentBulkRemoveInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const rows = await tx
          .select({
            id: shipments.id,
            controlNumber: shipments.controlNumber,
            status: shipments.status,
            movementId: shipments.movementId,
            movementStatus: movements.status,
          })
          .from(shipments)
          .leftJoin(movements, eq(movements.id, shipments.movementId))
          .where(and(eq(shipments.organizationId, ctx.orgId), inArray(shipments.id, input.ids)));
        const skipped: string[] = [];
        const touchedMovements = new Set<string>();
        let deleted = 0;
        for (const r of rows) {
          const editable =
            r.status === "draft" && (!r.movementStatus || isEditable(r.movementStatus));
          if (!editable) {
            skipped.push(r.controlNumber);
            continue;
          }
          await tx.delete(shipments).where(eq(shipments.id, r.id));
          await writeAudit(tx, ctx.orgId, "shipment.remove", "shipment", r.id, r, null);
          if (r.movementId) touchedMovements.add(r.movementId);
          deleted += 1;
        }
        for (const movementId of touchedMovements)
          await syncMovementRiskAlerts(tx, ctx.orgId, movementId);
        return { deleted, skipped };
      }),
    ),

  commodities: router({
    upsert: permissionProcedure("shipment.write")
      .input(commodityUpsertInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const { id, shipmentId, hazmat, ...fields } = input;
          const s = await requireEditableShipment(tx, ctx.orgId, shipmentId);
          let row: typeof commodities.$inferSelect | undefined;
          let before: typeof commodities.$inferSelect | null = null;
          if (id) {
            const [existing] = await tx
              .select()
              .from(commodities)
              .where(and(eq(commodities.id, id), eq(commodities.shipmentId, shipmentId)))
              .limit(1);
            before = existing ?? null;
            [row] = await tx
              .update(commodities)
              .set(fields)
              .where(and(eq(commodities.id, id), eq(commodities.shipmentId, shipmentId)))
              .returning();
            if (!row) throw new TRPCError({ code: "NOT_FOUND" });
          } else {
            const nextRows = await tx
              .select({ next: sql<number>`coalesce(max(${commodities.lineNumber}), 0) + 1` })
              .from(commodities)
              .where(eq(commodities.shipmentId, shipmentId));
            [row] = await tx
              .insert(commodities)
              .values({
                ...fields,
                shipmentId,
                organizationId: ctx.orgId,
                lineNumber: nextRows[0]?.next ?? 1,
              })
              .returning();
          }
          await writeHazmat(tx, ctx.orgId, row!.id, hazmat);
          if (s.movementId) await syncMovementRiskAlerts(tx, ctx.orgId, s.movementId);
          await writeAudit(
            tx,
            ctx.orgId,
            "shipment.commodity_upsert",
            "commodity",
            row!.id,
            before,
            row!,
          );
          return row!;
        }),
      ),
    remove: permissionProcedure("shipment.write")
      .input(commodityRemoveInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const s = await requireEditableShipment(tx, ctx.orgId, input.shipmentId);
          const [removed] = await tx
            .delete(commodities)
            .where(and(eq(commodities.id, input.id), eq(commodities.shipmentId, input.shipmentId)))
            .returning();
          if (s.movementId) await syncMovementRiskAlerts(tx, ctx.orgId, s.movementId);
          await writeAudit(
            tx,
            ctx.orgId,
            "shipment.commodity_remove",
            "commodity",
            input.id,
            removed ?? { shipmentId: input.shipmentId },
            null,
          );
          return { id: input.id };
        }),
      ),
  }),

  /** Draft/unassigned shipments of the movement's regime, for the assign dialog. */
  listForAssign: permissionProcedure("shipment.read")
    .input(z.object({ movementId: uuid, q: z.string().trim().max(100).optional() }))
    .query(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const m = await requireMovement(tx, ctx.orgId, input.movementId);
        const conds = [
          eq(shipments.organizationId, ctx.orgId),
          eq(shipments.regime, m.regime),
          isNull(shipments.movementId),
          eq(shipments.status, "draft"),
        ];
        if (input.q) {
          const like = containsPattern(input.q);
          conds.push(ilike(shipments.controlNumber, like));
        }
        return tx
          .select({
            id: shipments.id,
            controlNumber: shipments.controlNumber,
            shipmentType: shipments.shipmentType,
            cargoType: shipments.cargoType,
            shipperName: partners.name,
            commodityCount: sql<number>`(select count(*)::int from public.commodities c where c.shipment_id = ${shipments.id})`,
          })
          .from(shipments)
          .leftJoin(partners, eq(partners.id, shipments.shipperId))
          .where(and(...conds))
          .orderBy(asc(shipments.controlNumber))
          .limit(50);
      }),
    ),

  assign: permissionProcedure("shipment.write")
    .input(assignShipmentsInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const m = await requireMovement(tx, ctx.orgId, input.movementId);
        if (!isEditable(m.status)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Movement cannot be edited while ${m.status}`,
          });
        }
        const rows = await tx
          .update(shipments)
          .set({ movementId: m.id })
          .where(
            and(
              eq(shipments.organizationId, ctx.orgId),
              inArray(shipments.id, input.shipmentIds),
              eq(shipments.regime, m.regime),
              isNull(shipments.movementId),
              inArray(shipments.status, ["draft", "rejected"]),
            ),
          )
          .returning({ id: shipments.id });
        if (rows.length !== input.shipmentIds.length) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Some shipments could not be assigned — they must be unassigned drafts of the same regime.",
          });
        }
        await syncMovementRiskAlerts(tx, ctx.orgId, m.id);
        await writeAudit(tx, ctx.orgId, "shipment.assign", "movement", m.id, null, {
          shipmentIds: input.shipmentIds,
        });
        return { assigned: rows.length };
      }),
    ),

  unassign: permissionProcedure("shipment.write")
    .input(shipmentIdsInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const before = await tx
          .select({ id: shipments.id, movementId: shipments.movementId })
          .from(shipments)
          .where(
            and(eq(shipments.organizationId, ctx.orgId), inArray(shipments.id, input.shipmentIds)),
          );
        for (const s of before) {
          if (s.movementId) await requireEditableShipment(tx, ctx.orgId, s.id);
        }
        const rows = await tx
          .update(shipments)
          .set({ movementId: null })
          .where(
            and(
              eq(shipments.organizationId, ctx.orgId),
              inArray(shipments.id, input.shipmentIds),
              inArray(shipments.status, ["draft", "rejected"]),
            ),
          )
          .returning({ id: shipments.id });
        for (const movementId of new Set(before.map((s) => s.movementId).filter(Boolean))) {
          await syncMovementRiskAlerts(tx, ctx.orgId, movementId!);
        }
        await writeAudit(
          tx,
          ctx.orgId,
          "shipment.unassign",
          "shipment",
          input.shipmentIds[0]!,
          { movementIds: before.map((s) => s.movementId) },
          { shipmentIds: input.shipmentIds },
        );
        return { unassigned: rows.length };
      }),
    ),

  /** PARS RNS feed (0027): CBSA release notifications for our PARS shipments. */
  rns: router({
    list: permissionProcedure("shipment.read")
      .input(rnsListInput)
      .query(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const since = new Date(Date.now() - input.rangeDays * 86_400_000);
          const conds = [
            eq(parsRnsEvents.organizationId, ctx.orgId),
            gte(parsRnsEvents.receivedAt, since),
          ];
          if (input.q) {
            const like = containsPattern(input.q);
            conds.push(
              or(
                ilike(parsRnsEvents.parsNumber, like),
                ilike(parsRnsEvents.transactionNumber, like),
                ilike(parsRnsEvents.containerNumber, like),
              )!,
            );
          }
          const where = and(...conds);
          const [rows, counts] = await Promise.all([
            tx
              .select({
                id: parsRnsEvents.id,
                parsNumber: parsRnsEvents.parsNumber,
                releaseCode: parsRnsEvents.releaseCode,
                releasedAt: parsRnsEvents.releasedAt,
                officeCode: parsRnsEvents.officeCode,
                sublocationCode: parsRnsEvents.sublocationCode,
                transactionNumber: parsRnsEvents.transactionNumber,
                containerNumber: parsRnsEvents.containerNumber,
                receivedAt: parsRnsEvents.receivedAt,
                shipmentId: parsRnsEvents.shipmentId,
                movementId: shipments.movementId,
              })
              .from(parsRnsEvents)
              .leftJoin(shipments, eq(shipments.id, parsRnsEvents.shipmentId))
              .where(where)
              .orderBy(desc(parsRnsEvents.receivedAt))
              .limit(input.limit)
              .offset(input.offset),
            tx
              .select({ count: sql<number>`count(*)::int` })
              .from(parsRnsEvents)
              .where(where),
          ]);
          return { rows, total: counts[0]?.count ?? 0 };
        }),
      ),
  }),
});
