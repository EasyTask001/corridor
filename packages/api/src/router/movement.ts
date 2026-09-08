/**
 * Movement Builder core — headers, seals, transitions, amendments and
 * the append-only event timeline. Lifecycle primitives live in
 * services/movements.ts so background workers share them.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, ne, or, schema, sql } from "@corridor/db";
import {
  amendmentInput,
  crewInput,
  crewRemoveInput,
  crewSetRoleInput,
  customsResponseInput,
  hasBlockingIssues,
  isEditable,
  movementListInput,
  movementNoteInput,
  movementPatch,
  regime as regimeSchema,
  sealAddInput,
  sealRemoveInput,
  trailerAddInput,
  trailerRemoveInput,
  trailerReorderInput,
  uuid,
  type MovementPatch,
  type MovementStatus,
} from "@corridor/domain";
import {
  aiProcedure,
  anyPermissionProcedure,
  permissionProcedure,
  router,
  type OrgContext,
} from "../trpc";
import { simulateCustomsEvents } from "@corridor/integrations";
import { cancelAtCustoms, transmitAmendment, transmitMovement } from "../services/customs";
import { enqueueJob } from "../services/jobs";
import {
  acceptMovementSuggestion,
  dismissMovementSuggestion,
  generateMovementSuggestion,
} from "../services/predictive";
import {
  addEvent,
  applyCustomsDecision,
  applyTransition,
  loadFull,
  requireMovement,
  validationFor,
} from "../services/movements";
import { notifyUser, resolveDriverAssignment } from "../services/notifications";
import { writeAudit } from "../services/audit";
import { recordUsage } from "../services/usage";

const {
  movements,
  movementCrew,
  movementTrailers,
  movementAmendments,
  movementSuggestions,
  seals,
  drivers,
  trucks,
  trailers,
  equipmentTypes,
  partners,
  ports,
  organizationCarrierCodes,
} = schema;

function requireEditable(status: MovementStatus) {
  if (!isEditable(status)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Movement cannot be edited while ${status}`,
    });
  }
}

const actorOf = (ctx: OrgContext) => ({ orgId: ctx.orgId, userId: ctx.session.user.id });

/**
 * Step whoever currently holds the person-in-charge role down to crew member,
 * so the caller can hand it to somebody else. `movement_crew_pic_unique` is the
 * backstop; doing it here means promoting reads as a swap, not a constraint
 * violation the dispatcher has to unpick.
 */
const demotePersonInCharge = (
  tx: Parameters<typeof requireMovement>[0],
  movementId: string,
  except?: string,
) =>
  tx
    .update(movementCrew)
    .set({ role: "crew_member" })
    .where(
      and(
        eq(movementCrew.movementId, movementId),
        eq(movementCrew.role, "person_in_charge"),
        ...(except ? [ne(movementCrew.driverId, except)] : []),
      ),
    );

/**
 * The manifest flags a patch may set (0022). The ACI booleans are only
 * meaningful on an ACI movement — movements_aci_flags_check refuses them on
 * ACE — so they are dropped, not rejected, for ACE.
 */
function flagsFrom(
  regime: "ACE" | "ACI",
  p: Pick<
    MovementPatch,
    "iitIndicator" | "aciLvs" | "aciPostal" | "aciFlyingTruck" | "aciInTransit" | "aciIit"
  >,
): Partial<typeof movements.$inferInsert> {
  return {
    ...(p.iitIndicator !== undefined && { iitIndicator: p.iitIndicator }),
    ...(regime === "ACI" && {
      ...(p.aciLvs !== undefined && { aciLvs: p.aciLvs }),
      ...(p.aciPostal !== undefined && { aciPostal: p.aciPostal }),
      ...(p.aciFlyingTruck !== undefined && { aciFlyingTruck: p.aciFlyingTruck }),
      ...(p.aciInTransit !== undefined && { aciInTransit: p.aciInTransit }),
      ...(p.aciIit !== undefined && { aciIit: p.aciIit }),
    }),
  };
}

const customsSimulationEnabled = () =>
  process.env.CORRIDOR_ALLOW_CUSTOMS_SIMULATION === "true" || process.env.NODE_ENV !== "production";

export const movementRouter = router({
  list: anyPermissionProcedure("movement.read", "movement.read_assigned")
    .input(movementListInput)
    .query(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const conds = [eq(movements.organizationId, ctx.orgId)];
        if (input.status?.length) conds.push(inArray(movements.status, input.status));
        if (input.regime) conds.push(eq(movements.regime, input.regime));
        if (input.driverId)
          conds.push(
            sql`exists (select 1 from public.movement_crew mc
                        where mc.movement_id = ${movements.id} and mc.driver_id = ${input.driverId})`,
          );
        if (input.portId) conds.push(eq(movements.portId, input.portId));
        if (input.search) {
          const like = `%${input.search.replace(/[%_\\]/g, "\\$&")}%`;
          conds.push(
            or(
              ilike(movements.movementNumber, like),
              ilike(movements.tripNumber, like),
              ilike(movements.customsReferenceNumber, like),
            )!,
          );
        }
        const where = and(...conds);
        const [rawRows, counts] = await Promise.all([
          tx
            .select({
              id: movements.id,
              regime: movements.regime,
              movementNumber: movements.movementNumber,
              tripNumber: movements.tripNumber,
              status: movements.status,
              portId: movements.portId,
              portCode: ports.code,
              portName: ports.name,
              carrierCode: movements.carrierCode,
              scheduledCrossingAt: movements.scheduledCrossingAt,
              customsReferenceNumber: movements.customsReferenceNumber,
              driverName: sql<string | null>`(select d.first_name || ' ' || d.last_name
                from public.movement_crew mc
                join public.drivers d on d.id = mc.driver_id
                where mc.movement_id = ${movements.id} and mc.role = 'person_in_charge'
                limit 1)`,
              truckUnit: trucks.unitNumber,
              /** Every trailer in tow order, "TR-501 + TR-502" (0021). */
              trailerUnit: sql<string | null>`(select string_agg(t.unit_number, ' + ' order by mt.position)
                from public.movement_trailers mt
                join public.trailers t on t.id = mt.trailer_id
                where mt.movement_id = ${movements.id})`,
              shipmentCount: sql<number>`(select count(*)::int from public.shipments s where s.movement_id = ${movements.id})`,
              updatedAt: movements.updatedAt,
              createdAt: movements.createdAt,
            })
            .from(movements)
            .leftJoin(trucks, eq(trucks.id, movements.truckId))
            .leftJoin(ports, eq(ports.id, movements.portId))
            .where(where)
            .orderBy(desc(movements.updatedAt))
            .limit(input.limit)
            .offset(input.offset),
          tx
            .select({ count: sql<number>`count(*)::int` })
            .from(movements)
            .where(where),
        ]);
        const rows = rawRows.map(({ portCode, portName, ...row }) => ({
          ...row,
          port: portCode ? { code: portCode, name: portName! } : null,
        }));
        return { rows, total: counts[0]?.count ?? 0 };
      }),
    ),

  /** Status counts for the dispatcher board header. */
  board: anyPermissionProcedure("movement.read", "movement.read_assigned").query(({ ctx }) =>
    ctx.rls(async (tx) => {
      const rows = await tx
        .select({ status: movements.status, count: sql<number>`count(*)::int` })
        .from(movements)
        .where(eq(movements.organizationId, ctx.orgId))
        .groupBy(movements.status);
      return Object.fromEntries(rows.map((r) => [r.status, r.count])) as Partial<
        Record<MovementStatus, number>
      >;
    }),
  ),

  get: anyPermissionProcedure("movement.read", "movement.read_assigned")
    .input(z.object({ id: uuid }))
    .query(({ ctx, input }) => ctx.rls((tx) => loadFull(tx, ctx.orgId, input.id))),

  validate: anyPermissionProcedure("movement.read", "movement.read_assigned")
    .input(z.object({ id: uuid }))
    .query(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const full = await loadFull(tx, ctx.orgId, input.id);
        const issues = validationFor(full);
        return { issues, canTransmit: !hasBlockingIssues(issues) };
      }),
    ),

  create: permissionProcedure("movement.write")
    .input(z.object({ regime: regimeSchema, tripNumber: z.string().trim().max(40).optional() }))
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const numRes = await tx.execute<{ n: string }>(
          sql`select public.next_movement_number(${ctx.orgId}::uuid, ${input.regime}) as n`,
        );
        const movementNumber = numRes[0]!.n;
        // New movements start on the regime's default filing code; the trip
        // step can change it before transmit.
        const [defaultCode] = await tx
          .select({ code: organizationCarrierCodes.code })
          .from(organizationCarrierCodes)
          .where(
            and(
              eq(organizationCarrierCodes.organizationId, ctx.orgId),
              eq(organizationCarrierCodes.regime, input.regime),
              eq(organizationCarrierCodes.isDefault, true),
            ),
          )
          .limit(1);
        const [m] = await tx
          .insert(movements)
          .values({
            organizationId: ctx.orgId,
            regime: input.regime,
            movementNumber,
            tripNumber: input.tripNumber ?? null,
            carrierCode: defaultCode?.code ?? null,
            createdBy: ctx.session.user.id,
          })
          .returning();
        await addEvent(tx, actorOf(ctx), m!.id, {
          eventType: "status_change",
          fromStatus: null,
          toStatus: "draft",
          actorType: "user",
          payload: { movementNumber },
        });
        await writeAudit(tx, ctx.orgId, "movement.create", "movement", m!.id, null, m!);
        return m!;
      }),
    ),

  update: permissionProcedure("movement.write")
    .input(movementPatch.extend({ id: uuid }))
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const { id, ...patch } = input;
        const m = await requireMovement(tx, ctx.orgId, id);
        requireEditable(m.status);
        const [row] = await tx
          .update(movements)
          .set({
            ...(patch.tripNumber !== undefined && { tripNumber: patch.tripNumber }),
            ...(patch.portId !== undefined && { portId: patch.portId }),
            ...(patch.carrierCode !== undefined && { carrierCode: patch.carrierCode }),
            ...(patch.scheduledCrossingAt !== undefined && {
              scheduledCrossingAt: patch.scheduledCrossingAt
                ? new Date(patch.scheduledCrossingAt)
                : null,
            }),
            ...(patch.truckId !== undefined && { truckId: patch.truckId }),
            ...(patch.isEmpty !== undefined && { isEmpty: patch.isEmpty }),
            ...flagsFrom(m.regime, patch),
            ...(patch.notes !== undefined && { notes: patch.notes }),
          })
          .where(eq(movements.id, id))
          .returning();
        await writeAudit(tx, ctx.orgId, "movement.update", "movement", id, m, row!);
        return row!;
      }),
    ),

  crew: router({
    /**
     * Put a person on the crossing. Promoting someone to person in charge
     * demotes whoever held it (movement_crew_pic_unique allows exactly one).
     *
     * Being put on a load is the one change a crew member needs to hear about.
     * It is *resolved* inside the transaction (so `drivers` is read under the
     * caller's RLS) but *delivered* after it commits: delivery needs the
     * service role, and taking that connection while this one is still open
     * would hold two from the same pool per request.
     */
    add: permissionProcedure("movement.write")
      .input(crewInput)
      .mutation(async ({ ctx, input }) => {
        let pending: Awaited<ReturnType<typeof resolveDriverAssignment>> = null;
        const row = await ctx.rls(async (tx) => {
          const m = await requireMovement(tx, ctx.orgId, input.movementId);
          requireEditable(m.status);
          if (input.role === "person_in_charge") await demotePersonInCharge(tx, input.movementId);
          const nextRows = await tx
            .select({ next: sql<number>`coalesce(max(${movementCrew.position}), 0) + 1` })
            .from(movementCrew)
            .where(eq(movementCrew.movementId, input.movementId));
          const [crew] = await tx
            .insert(movementCrew)
            .values({
              organizationId: ctx.orgId,
              movementId: input.movementId,
              driverId: input.driverId,
              role: input.role,
              position: nextRows[0]?.next ?? 1,
            })
            .returning()
            .catch((e: unknown) => {
              if ((e as { cause?: { code?: string } })?.cause?.code === "23505")
                throw new TRPCError({
                  code: "CONFLICT",
                  message: "That person is already on this crossing",
                });
              throw e;
            });
          await writeAudit(
            tx,
            ctx.orgId,
            "movement.crew_add",
            "movement_crew",
            crew!.id,
            null,
            crew!,
          );
          pending = await resolveDriverAssignment(tx, {
            orgId: ctx.orgId,
            driverId: input.driverId,
            movementId: input.movementId,
            movementNumber: m.movementNumber,
            actorUserId: ctx.session.user.id,
          });
          return crew!;
        });
        // Post-commit: no transaction of ours is open, so notifyUser's
        // service-role transaction is the only connection in play.
        //
        // Never rethrow. The assignment is already durably committed, and a
        // notification that could not be delivered is not a reason to hand the
        // dispatcher a failed mutation — they would retry an edit that already
        // succeeded. Log it instead and return the row.
        if (pending) {
          try {
            await notifyUser(ctx.db, pending);
          } catch (error) {
            console.error(
              `[notifications] movement.assigned dispatch failed for movement ${input.movementId} / driver ${input.driverId} (the assignment itself is committed)`,
              error,
            );
          }
        }
        return row;
      }),

    remove: permissionProcedure("movement.write")
      .input(crewRemoveInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const m = await requireMovement(tx, ctx.orgId, input.movementId);
          requireEditable(m.status);
          const [removed] = await tx
            .delete(movementCrew)
            .where(
              and(
                eq(movementCrew.movementId, input.movementId),
                eq(movementCrew.driverId, input.driverId),
              ),
            )
            .returning();
          if (!removed) throw new TRPCError({ code: "NOT_FOUND", message: "Not on this crossing" });
          await writeAudit(
            tx,
            ctx.orgId,
            "movement.crew_remove",
            "movement_crew",
            removed.id,
            removed,
            null,
          );
          return { id: removed.id };
        }),
      ),

    setRole: permissionProcedure("movement.write")
      .input(crewSetRoleInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const m = await requireMovement(tx, ctx.orgId, input.movementId);
          requireEditable(m.status);
          if (input.role === "person_in_charge")
            await demotePersonInCharge(tx, input.movementId, input.driverId);
          const [row] = await tx
            .update(movementCrew)
            .set({ role: input.role })
            .where(
              and(
                eq(movementCrew.movementId, input.movementId),
                eq(movementCrew.driverId, input.driverId),
              ),
            )
            .returning();
          if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Not on this crossing" });
          await writeAudit(
            tx,
            ctx.orgId,
            "movement.crew_set_role",
            "movement_crew",
            row.id,
            null,
            { driverId: input.driverId, role: input.role },
          );
          return row;
        }),
      ),
  }),

  trailers: router({
    /** Hitch a trailer; it goes to the back of the tow. */
    add: permissionProcedure("movement.write")
      .input(trailerAddInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const m = await requireMovement(tx, ctx.orgId, input.movementId);
          requireEditable(m.status);
          const [unit] = await tx
            .select({ id: trailers.id })
            .from(trailers)
            .where(and(eq(trailers.id, input.trailerId), eq(trailers.organizationId, ctx.orgId)))
            .limit(1);
          if (!unit) throw new TRPCError({ code: "NOT_FOUND", message: "Trailer not found" });
          const nextRows = await tx
            .select({ next: sql<number>`coalesce(max(${movementTrailers.position}), 0) + 1` })
            .from(movementTrailers)
            .where(eq(movementTrailers.movementId, input.movementId));
          const [row] = await tx
            .insert(movementTrailers)
            .values({
              organizationId: ctx.orgId,
              movementId: input.movementId,
              trailerId: input.trailerId,
              position: nextRows[0]?.next ?? 1,
            })
            .returning()
            .catch((e: unknown) => {
              if ((e as { cause?: { code?: string } })?.cause?.code === "23505")
                throw new TRPCError({
                  code: "CONFLICT",
                  message: "That trailer is already on this movement",
                });
              throw e;
            });
          await writeAudit(
            tx,
            ctx.orgId,
            "movement.trailer_add",
            "movement_trailer",
            row!.id,
            null,
            row!,
          );
          return row!;
        }),
      ),

    /** Drop a trailer; its seals go with it (on delete cascade). */
    remove: permissionProcedure("movement.write")
      .input(trailerRemoveInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const m = await requireMovement(tx, ctx.orgId, input.movementId);
          requireEditable(m.status);
          const [removed] = await tx
            .delete(movementTrailers)
            .where(
              and(
                eq(movementTrailers.movementId, input.movementId),
                eq(movementTrailers.trailerId, input.trailerId),
              ),
            )
            .returning();
          if (!removed)
            throw new TRPCError({ code: "NOT_FOUND", message: "Not on this movement" });
          await writeAudit(
            tx,
            ctx.orgId,
            "movement.trailer_remove",
            "movement_trailer",
            removed.id,
            removed,
            null,
          );
          return { id: removed.id };
        }),
      ),

    /** Set the tow order; `trailerIds` must be exactly the trailers on the movement. */
    reorder: permissionProcedure("movement.write")
      .input(trailerReorderInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const m = await requireMovement(tx, ctx.orgId, input.movementId);
          requireEditable(m.status);
          const current = await tx
            .select({ id: movementTrailers.id, trailerId: movementTrailers.trailerId })
            .from(movementTrailers)
            .where(eq(movementTrailers.movementId, input.movementId));
          const wanted = new Set(input.trailerIds);
          if (
            wanted.size !== input.trailerIds.length ||
            current.length !== wanted.size ||
            current.some((c) => !wanted.has(c.trailerId))
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Tow order must list every trailer on the movement exactly once",
            });
          }
          for (const [i, trailerId] of input.trailerIds.entries()) {
            await tx
              .update(movementTrailers)
              .set({ position: i + 1 })
              .where(
                and(
                  eq(movementTrailers.movementId, input.movementId),
                  eq(movementTrailers.trailerId, trailerId),
                ),
              );
          }
          await writeAudit(
            tx,
            ctx.orgId,
            "movement.trailer_reorder",
            "movement",
            input.movementId,
            null,
            { trailerIds: input.trailerIds },
          );
          return { ok: true };
        }),
      ),
  }),

  seals: router({
    add: permissionProcedure("movement.write")
      .input(sealAddInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const { movementId, ...fields } = input;
          const m = await requireMovement(tx, ctx.orgId, movementId);
          requireEditable(m.status);
          // A seal goes on one of this movement's trailer slots, or on the
          // truck (null). seals_limit() is the backstop for both the slot
          // ownership and the 4-per-trailer / 1-per-truck cap.
          if (fields.movementTrailerId) {
            const [slot] = await tx
              .select({ id: movementTrailers.id })
              .from(movementTrailers)
              .where(
                and(
                  eq(movementTrailers.id, fields.movementTrailerId),
                  eq(movementTrailers.movementId, movementId),
                ),
              )
              .limit(1);
            if (!slot)
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "That trailer is not on this movement",
              });
          }
          const [row] = await tx
            .insert(seals)
            .values({
              movementId,
              organizationId: ctx.orgId,
              movementTrailerId: fields.movementTrailerId ?? null,
              sealNumber: fields.sealNumber,
              sealType: fields.sealType ?? null,
              appliedBy: fields.appliedBy ?? null,
              appliedAt: fields.appliedAt ? new Date(fields.appliedAt) : null,
            })
            .returning()
            .catch((e: unknown) => {
              const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
              if (cause?.code === "23505")
                throw new TRPCError({
                  code: "CONFLICT",
                  message: "Seal already recorded on this movement",
                });
              if (cause?.code === "P0001" && cause.message?.includes("seal limit"))
                throw new TRPCError({ code: "PRECONDITION_FAILED", message: cause.message });
              throw e;
            });
          await writeAudit(tx, ctx.orgId, "movement.seal_add", "seal", row!.id, null, row!);
          return row!;
        }),
      ),
    remove: permissionProcedure("movement.write")
      .input(sealRemoveInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const m = await requireMovement(tx, ctx.orgId, input.movementId);
          requireEditable(m.status);
          const [removed] = await tx
            .delete(seals)
            .where(and(eq(seals.id, input.id), eq(seals.movementId, input.movementId)))
            .returning();
          await writeAudit(
            tx,
            ctx.orgId,
            "movement.seal_remove",
            "seal",
            input.id,
            removed ?? { movementId: input.movementId },
            null,
          );
          return { id: input.id };
        }),
      ),
  }),

  addNote: permissionProcedure("movement.write")
    .input(movementNoteInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const m = await requireMovement(tx, ctx.orgId, input.movementId);
        await addEvent(tx, actorOf(ctx), input.movementId, {
          eventType: "note",
          actorType: "user",
          payload: { body: input.body },
        });
        // Keep note writes independent of the embedding provider. The worker
        // retries failures without rolling back or delaying the user action.
        await enqueueJob(tx, {
          orgId: ctx.orgId,
          jobType: "copilot.embed_knowledge",
          payload: {
            sourceType: "movement_note",
            sourceId: input.movementId,
            content: `Movement ${m.movementNumber}: ${input.body}`,
          },
        });
        await writeAudit(tx, ctx.orgId, "movement.note_add", "movement", input.movementId, null, {
          movementNumber: m.movementNumber,
          body: input.body,
        });
        return { ok: true };
      }),
    ),

  /**
   * draft | rejected → sent. Validates, builds the e-manifest, calls the
   * (mock or real) customs gateway, logs the integration event and enqueues
   * the asynchronous decision. Transport failures leave the movement editable
   * and are surfaced as BAD_GATEWAY *after* the failure row is committed.
   */
  submit: permissionProcedure("movement.transmit_to_customs")
    .input(z.object({ id: uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.rls(async (tx) => {
        const before = await requireMovement(tx, ctx.orgId, input.id);
        const r = await transmitMovement(tx, actorOf(ctx), input.id);
        if ("transportError" in r && r.transportError) {
          // The transaction still commits (the integration_events failure row
          // is the point), so the failed attempt belongs in the log too.
          await writeAudit(tx, ctx.orgId, "movement.submit_failed", "movement", input.id, null, {
            statusCode: r.transportError.statusCode,
            retryable: r.transportError.retryable,
            error: r.transportError.message,
          });
          return r;
        }
        await writeAudit(
          tx,
          ctx.orgId,
          "movement.submit",
          "movement",
          input.id,
          { status: before.status },
          { status: r.movement.status, referenceNumber: r.referenceNumber },
        );
        await recordUsage(tx, ctx.orgId, "movements_transmitted", 1, {
          movementId: input.id,
          regime: r.movement.regime,
        });
        return r;
      });
      if ("transportError" in result && result.transportError) {
        const e = result.transportError;
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: e.retryable
            ? `${e.message}. The manifest was not transmitted — try again shortly.`
            : `${e.message}. Check the integration settings.`,
        });
      }
      return result;
    }),

  cancel: permissionProcedure("movement.cancel")
    .input(z.object({ id: uuid, reason: z.string().trim().max(500).optional() }))
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const m = await requireMovement(tx, ctx.orgId, input.id);
        // A filed manifest is withdrawn at the gateway first; a transport
        // failure throws and nothing below is committed.
        const ack = await cancelAtCustoms(tx, actorOf(ctx), m, input.reason ?? null);
        const row = await applyTransition(
          tx,
          actorOf(ctx),
          m,
          "cancelled",
          "user",
          {},
          { reason: input.reason ?? null, ...(ack && { customsAcknowledged: ack.receivedAt }) },
        );
        await writeAudit(
          tx,
          ctx.orgId,
          "movement.cancel",
          "movement",
          m.id,
          { status: m.status },
          { status: row.status, reason: input.reason ?? null },
        );
        return row;
      }),
    ),

  /** released → arrived (driver/dispatcher confirms arrival at destination). */
  markArrived: permissionProcedure("movement.write")
    .input(z.object({ id: uuid }))
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const m = await requireMovement(tx, ctx.orgId, input.id);
        const row = await applyTransition(tx, actorOf(ctx), m, "arrived", "user");
        await writeAudit(
          tx,
          ctx.orgId,
          "movement.mark_arrived",
          "movement",
          m.id,
          { status: m.status },
          { status: row.status },
        );
        return row;
      }),
    ),

  /** Amend an accepted manifest: apply header changes + re-transmit (accepted → sent). */
  amend: permissionProcedure("movement.amend")
    .input(amendmentInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const m = await requireMovement(tx, ctx.orgId, input.movementId);
        if (m.status !== "accepted") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Only accepted manifests can be amended",
          });
        }
        const p = input.patch;
        const diff: Record<string, { before: unknown; after: unknown }> = {};
        const set: Partial<typeof movements.$inferInsert> = {};
        const consider = <K extends keyof typeof set>(key: K, before: unknown, after: unknown) => {
          if (after === undefined) return;
          if (JSON.stringify(before) === JSON.stringify(after)) return;
          diff[key as string] = { before, after };
          (set as Record<string, unknown>)[key as string] = after;
        };
        consider("tripNumber", m.tripNumber, p.tripNumber);
        consider("portId", m.portId, p.portId);
        consider("carrierCode", m.carrierCode, p.carrierCode);
        consider(
          "scheduledCrossingAt",
          m.scheduledCrossingAt?.toISOString() ?? null,
          p.scheduledCrossingAt === undefined ? undefined : p.scheduledCrossingAt,
        );
        if (set.scheduledCrossingAt !== undefined) {
          set.scheduledCrossingAt = set.scheduledCrossingAt
            ? new Date(set.scheduledCrossingAt as unknown as string)
            : null;
        }
        consider("truckId", m.truckId, p.truckId);
        consider("isEmpty", m.isEmpty, p.isEmpty);
        const flags = flagsFrom(m.regime, p);
        for (const [key, after] of Object.entries(flags))
          consider(key as keyof typeof set, m[key as keyof typeof m], after);
        if (Object.keys(diff).length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Amendment contains no changes" });
        }
        // CBSA wants a reason code with every amendment; the DB trigger
        // (movement_amendments_reason_guard) is the backstop.
        if (m.regime === "ACI" && !input.reasonCode) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "An ACI amendment needs a CBSA reason code",
          });
        }

        const nextRows = await tx
          .select({
            next: sql<number>`coalesce(max(${movementAmendments.amendmentNumber}), 0) + 1`,
          })
          .from(movementAmendments)
          .where(eq(movementAmendments.movementId, m.id));
        const next = nextRows[0]?.next ?? 1;
        const [amendment] = await tx
          .insert(movementAmendments)
          .values({
            movementId: m.id,
            organizationId: ctx.orgId,
            amendmentNumber: next,
            reason: input.reason,
            reasonCode: input.reasonCode ?? null,
            shipmentId: input.shipmentId ?? null,
            diff,
            status: "submitted",
            createdBy: ctx.session.user.id,
          })
          .returning()
          .catch((e: unknown) => {
            const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
            if (cause?.code === "P0001")
              throw new TRPCError({ code: "BAD_REQUEST", message: cause.message ?? "Invalid amendment" });
            throw e;
          });
        await addEvent(tx, actorOf(ctx), m.id, {
          eventType: "amendment",
          actorType: "user",
          shipmentId: input.shipmentId ?? null,
          payload: {
            amendmentNumber: next,
            reason: input.reason,
            reasonCode: input.reasonCode ?? null,
            diff,
          },
        });
        // One UPDATE: status change + patched fields (the guard permits edits alongside a transition).
        const updated = await applyTransition(tx, actorOf(ctx), m, "sent", "user", set, {
          amendmentNumber: next,
        });
        // Re-file with the gateway (0023). Throws on transport failure, which
        // rolls the amendment and the transition back.
        await transmitAmendment(tx, actorOf(ctx), m.id, next);
        await writeAudit(
          tx,
          ctx.orgId,
          "movement.amend",
          "movement",
          m.id,
          { status: m.status },
          {
            status: updated.status,
            amendmentNumber: next,
            reason: input.reason,
            reasonCode: input.reasonCode ?? null,
            diff,
          },
        );
        return { movement: updated, amendment: amendment! };
      }),
    ),

  /**
   * Dev-only customs simulation. Real decisions arrive through the
   * customs.decide background job (services/jobs.ts). Disabled in production
   * unless CORRIDOR_ALLOW_CUSTOMS_SIMULATION=true.
   */
  customsResponse: permissionProcedure("movement.transmit_to_customs")
    .input(customsResponseInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        if (!customsSimulationEnabled()) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Customs simulation is disabled" });
        }
        const m = await requireMovement(tx, ctx.orgId, input.movementId);
        if (m.status !== "sent" && m.status !== "accepted" && m.status !== "held") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `No customs decision is pending while ${m.status}`,
          });
        }
        const referenceNumber =
          input.referenceNumber ??
          m.customsReferenceNumber ??
          `${m.regime}-SIM-${Date.now().toString(36).toUpperCase()}`;
        // Same message sequence the mock gateway would send, so the timeline
        // and the shipments' entry numbers look the same either way.
        const full = await loadFull(tx, ctx.orgId, m.id);
        const simulated = simulateCustomsEvents({
          regime: m.regime,
          decision: input.decision,
          currentStatus: m.status,
          referenceNumber,
          portOfEntry: full.port?.code ?? null,
          shipments: full.shipments.map((s) => ({ controlNumber: s.controlNumber })),
        });
        const row = await applyCustomsDecision(tx, actorOf(ctx), m, {
          decision: input.decision,
          referenceNumber,
          message: input.message ?? null,
          simulated: true,
          events: simulated.events,
          shipments: simulated.shipments,
        });
        await writeAudit(
          tx,
          ctx.orgId,
          "movement.customs_response",
          "movement",
          m.id,
          { status: m.status },
          {
            status: row.status,
            decision: input.decision,
            message: input.message ?? null,
            simulated: true,
          },
        );
        return row;
      }),
    ),

  suggestions: router({
    generate: aiProcedure("movement.write")
      .input(z.object({ movementId: uuid }))
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const suggestion = await generateMovementSuggestion(
            tx,
            ctx.orgId,
            ctx.session.user.id,
            input.movementId,
          );
          // null = nothing close enough in the history to suggest. Nothing was
          // produced, so there is nothing to audit or to bill for.
          if (!suggestion) return suggestion;
          await writeAudit(
            tx,
            ctx.orgId,
            "movement.suggestion_generate",
            "movement_suggestion",
            suggestion.id,
            null,
            {
              movementId: input.movementId,
              sourceMovementId: suggestion.sourceMovementId,
              score: suggestion.score,
            },
          );
          await recordUsage(tx, ctx.orgId, "ai_suggestions", 1, {
            movementId: input.movementId,
            suggestionId: suggestion.id,
          });
          return suggestion;
        }),
      ),
    accept: permissionProcedure("movement.write")
      .input(z.object({ suggestionId: uuid }))
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const decided = await acceptMovementSuggestion(tx, ctx.orgId, input.suggestionId);
          await writeAudit(
            tx,
            ctx.orgId,
            "movement.suggestion_accept",
            "movement_suggestion",
            decided.id,
            { status: "offered" },
            { status: decided.status, movementId: decided.movementId },
          );
          return decided;
        }),
      ),
    dismiss: permissionProcedure("movement.write")
      .input(z.object({ suggestionId: uuid }))
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const decided = await dismissMovementSuggestion(tx, ctx.orgId, input.suggestionId);
          await writeAudit(
            tx,
            ctx.orgId,
            "movement.suggestion_dismiss",
            "movement_suggestion",
            decided.id,
            { status: "offered" },
            { status: decided.status, movementId: decided.movementId },
          );
          return decided;
        }),
      ),
    stats: permissionProcedure("movement.read").query(({ ctx }) =>
      ctx.rls(async (tx) => {
        const rows = await tx
          .select({ status: movementSuggestions.status, count: sql<number>`count(*)::int` })
          .from(movementSuggestions)
          .where(eq(movementSuggestions.organizationId, ctx.orgId))
          .groupBy(movementSuggestions.status);
        const counts = Object.fromEntries(rows.map((row) => [row.status, row.count]));
        const decided = (counts.accepted ?? 0) + (counts.dismissed ?? 0);
        return {
          offered: counts.offered ?? 0,
          accepted: counts.accepted ?? 0,
          dismissed: counts.dismissed ?? 0,
          acceptanceRate: decided ? (counts.accepted ?? 0) / decided : null,
        };
      }),
    ),
  }),

  /** Lookup data for the wizard dropdowns in one round-trip. */
  options: permissionProcedure("movement.read").query(({ ctx }) =>
    ctx.rls(async (tx) => {
      const [d, t, tr, p, cc] = await Promise.all([
        tx
          .select({
            id: drivers.id,
            label: sql<string>`${drivers.lastName} || ', ' || ${drivers.firstName}`,
            licenseExpiry: drivers.licenseExpiry,
            personType: drivers.personType,
          })
          .from(drivers)
          .where(and(eq(drivers.organizationId, ctx.orgId), eq(drivers.status, "active")))
          .orderBy(asc(drivers.lastName)),
        tx
          .select({ id: trucks.id, label: trucks.unitNumber, plate: trucks.plateNumber })
          .from(trucks)
          .where(and(eq(trucks.organizationId, ctx.orgId), eq(trucks.status, "active")))
          .orderBy(asc(trucks.unitNumber)),
        tx
          .select({
            id: trailers.id,
            label: trailers.unitNumber,
            type: trailers.trailerType,
            typeLabel: equipmentTypes.label,
          })
          .from(trailers)
          .leftJoin(equipmentTypes, eq(equipmentTypes.code, trailers.trailerType))
          .where(and(eq(trailers.organizationId, ctx.orgId), eq(trailers.status, "active")))
          .orderBy(asc(trailers.unitNumber)),
        tx
          .select({ id: partners.id, label: partners.name, type: partners.type })
          .from(partners)
          .where(and(eq(partners.organizationId, ctx.orgId), eq(partners.status, "active")))
          .orderBy(asc(partners.name)),
        tx
          .select({
            id: organizationCarrierCodes.id,
            regime: organizationCarrierCodes.regime,
            code: organizationCarrierCodes.code,
            label: organizationCarrierCodes.label,
            isDefault: organizationCarrierCodes.isDefault,
          })
          .from(organizationCarrierCodes)
          .where(
            and(
              eq(organizationCarrierCodes.organizationId, ctx.orgId),
              eq(organizationCarrierCodes.status, "active"),
            ),
          )
          .orderBy(organizationCarrierCodes.regime, desc(organizationCarrierCodes.isDefault)),
      ]);
      return { drivers: d, trucks: t, trailers: tr, partners: p, carrierCodes: cc };
    }),
  ),
});
