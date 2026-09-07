/**
 * Movement Builder core — headers, cargo, seals, transitions, amendments and
 * the append-only event timeline. Lifecycle primitives live in
 * services/movements.ts so background workers share them.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, or, schema, sql } from "@corridor/db";
import {
  amendmentInput,
  cargoRemoveInput,
  cargoUpsertInput,
  customsResponseInput,
  hasBlockingIssues,
  isEditable,
  movementListInput,
  movementNoteInput,
  movementPatch,
  regime as regimeSchema,
  sealAddInput,
  sealRemoveInput,
  uuid,
  type MovementStatus,
} from "@corridor/domain";
import {
  aiProcedure,
  anyPermissionProcedure,
  permissionProcedure,
  router,
  type OrgContext,
} from "../trpc";
import { transmitMovement } from "../services/customs";
import { enqueueJob } from "../services/jobs";
import { syncMovementRiskAlerts } from "../services/risk";
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
  movementAmendments,
  movementSuggestions,
  cargo,
  seals,
  drivers,
  trucks,
  trailers,
  partners,
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
        if (input.driverId) conds.push(eq(movements.driverId, input.driverId));
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
        const [rows, counts] = await Promise.all([
          tx
            .select({
              id: movements.id,
              regime: movements.regime,
              movementNumber: movements.movementNumber,
              tripNumber: movements.tripNumber,
              status: movements.status,
              crossingPoint: movements.crossingPoint,
              scheduledCrossingAt: movements.scheduledCrossingAt,
              customsReferenceNumber: movements.customsReferenceNumber,
              driverName: sql<string | null>`${drivers.firstName} || ' ' || ${drivers.lastName}`,
              truckUnit: trucks.unitNumber,
              trailerUnit: trailers.unitNumber,
              cargoCount: sql<number>`(select count(*)::int from public.cargo c where c.movement_id = ${movements.id})`,
              updatedAt: movements.updatedAt,
              createdAt: movements.createdAt,
            })
            .from(movements)
            .leftJoin(drivers, eq(drivers.id, movements.driverId))
            .leftJoin(trucks, eq(trucks.id, movements.truckId))
            .leftJoin(trailers, eq(trailers.id, movements.trailerId))
            .where(where)
            .orderBy(desc(movements.updatedAt))
            .limit(input.limit)
            .offset(input.offset),
          tx
            .select({ count: sql<number>`count(*)::int` })
            .from(movements)
            .where(where),
        ]);
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
        const [m] = await tx
          .insert(movements)
          .values({
            organizationId: ctx.orgId,
            regime: input.regime,
            movementNumber,
            tripNumber: input.tripNumber ?? null,
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
    .mutation(async ({ ctx, input }) => {
      // Assigning (or reassigning) a driver is the one patch a driver needs to
      // hear about. It is *resolved* inside the transaction (so `drivers` is
      // read under the caller's RLS) but *delivered* after it commits: delivery
      // needs the service role, and taking that connection while this one is
      // still open would hold two from the same pool per request.
      let pending: Awaited<ReturnType<typeof resolveDriverAssignment>> = null;
      const row = await ctx.rls(async (tx) => {
        const { id, ...patch } = input;
        const m = await requireMovement(tx, ctx.orgId, id);
        requireEditable(m.status);
        const [row] = await tx
          .update(movements)
          .set({
            ...(patch.tripNumber !== undefined && { tripNumber: patch.tripNumber }),
            ...(patch.crossingPoint !== undefined && { crossingPoint: patch.crossingPoint }),
            ...(patch.scheduledCrossingAt !== undefined && {
              scheduledCrossingAt: patch.scheduledCrossingAt
                ? new Date(patch.scheduledCrossingAt)
                : null,
            }),
            ...(patch.driverId !== undefined && { driverId: patch.driverId }),
            ...(patch.truckId !== undefined && { truckId: patch.truckId }),
            ...(patch.trailerId !== undefined && { trailerId: patch.trailerId }),
            ...(patch.notes !== undefined && { notes: patch.notes }),
          })
          .where(eq(movements.id, id))
          .returning();
        await writeAudit(tx, ctx.orgId, "movement.update", "movement", id, m, row!);
        if (patch.driverId && patch.driverId !== m.driverId) {
          pending = await resolveDriverAssignment(tx, {
            orgId: ctx.orgId,
            driverId: patch.driverId,
            movementId: id,
            movementNumber: row!.movementNumber,
            actorUserId: ctx.session.user.id,
          });
        }
        return row!;
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
            `[notifications] movement.assigned dispatch failed for movement ${input.id} / driver ${input.driverId ?? "unknown"} (the update itself is committed)`,
            error,
          );
        }
      }
      return row;
    }),

  cargo: router({
    upsert: permissionProcedure("movement.write")
      .input(cargoUpsertInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const { id, movementId, ...fields } = input;
          const m = await requireMovement(tx, ctx.orgId, movementId);
          requireEditable(m.status);
          if (id) {
            const [before] = await tx
              .select()
              .from(cargo)
              .where(and(eq(cargo.id, id), eq(cargo.movementId, movementId)))
              .limit(1);
            const [row] = await tx
              .update(cargo)
              .set(fields)
              .where(and(eq(cargo.id, id), eq(cargo.movementId, movementId)))
              .returning();
            if (!row) throw new TRPCError({ code: "NOT_FOUND" });
            await syncMovementRiskAlerts(tx, ctx.orgId, movementId);
            await writeAudit(
              tx,
              ctx.orgId,
              "movement.cargo_upsert",
              "cargo",
              row.id,
              before ?? null,
              row,
            );
            return row;
          }
          const nextRows = await tx
            .select({ next: sql<number>`coalesce(max(${cargo.lineNumber}), 0) + 1` })
            .from(cargo)
            .where(eq(cargo.movementId, movementId));
          const next = nextRows[0]?.next ?? 1;
          const [row] = await tx
            .insert(cargo)
            .values({ ...fields, movementId, organizationId: ctx.orgId, lineNumber: next })
            .returning();
          await syncMovementRiskAlerts(tx, ctx.orgId, movementId);
          await writeAudit(tx, ctx.orgId, "movement.cargo_upsert", "cargo", row!.id, null, row!);
          return row!;
        }),
      ),
    remove: permissionProcedure("movement.write")
      .input(cargoRemoveInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const m = await requireMovement(tx, ctx.orgId, input.movementId);
          requireEditable(m.status);
          const [removed] = await tx
            .delete(cargo)
            .where(and(eq(cargo.id, input.id), eq(cargo.movementId, input.movementId)))
            .returning();
          await writeAudit(
            tx,
            ctx.orgId,
            "movement.cargo_remove",
            "cargo",
            input.id,
            removed ?? { movementId: input.movementId },
            null,
          );
          return { id: input.id };
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
          const [row] = await tx
            .insert(seals)
            .values({
              movementId,
              organizationId: ctx.orgId,
              trailerId: fields.trailerId ?? m.trailerId,
              sealNumber: fields.sealNumber,
              sealType: fields.sealType ?? null,
              appliedBy: fields.appliedBy ?? null,
              appliedAt: fields.appliedAt ? new Date(fields.appliedAt) : null,
            })
            .returning()
            .catch((e: unknown) => {
              const code = (e as { cause?: { code?: string } })?.cause?.code;
              if (code === "23505")
                throw new TRPCError({
                  code: "CONFLICT",
                  message: "Seal already recorded on this movement",
                });
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
        const row = await applyTransition(
          tx,
          actorOf(ctx),
          m,
          "cancelled",
          "user",
          {},
          { reason: input.reason ?? null },
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
        consider("crossingPoint", m.crossingPoint, p.crossingPoint);
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
        consider("driverId", m.driverId, p.driverId);
        consider("truckId", m.truckId, p.truckId);
        consider("trailerId", m.trailerId, p.trailerId);
        if (Object.keys(diff).length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Amendment contains no changes" });
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
            diff,
            status: "submitted",
            createdBy: ctx.session.user.id,
          })
          .returning();
        await addEvent(tx, actorOf(ctx), m.id, {
          eventType: "amendment",
          actorType: "user",
          payload: { amendmentNumber: next, reason: input.reason, diff },
        });
        // One UPDATE: status change + patched fields (the guard permits edits alongside a transition).
        const updated = await applyTransition(tx, actorOf(ctx), m, "sent", "user", set, {
          amendmentNumber: next,
        });
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
        const row = await applyCustomsDecision(tx, actorOf(ctx), m, {
          decision: input.decision,
          referenceNumber:
            input.referenceNumber ??
            m.customsReferenceNumber ??
            `${m.regime}-SIM-${Date.now().toString(36).toUpperCase()}`,
          message: input.message ?? null,
          simulated: true,
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
      const [d, t, tr, p] = await Promise.all([
        tx
          .select({
            id: drivers.id,
            label: sql<string>`${drivers.lastName} || ', ' || ${drivers.firstName}`,
            licenseExpiry: drivers.licenseExpiry,
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
          .select({ id: trailers.id, label: trailers.unitNumber, type: trailers.trailerType })
          .from(trailers)
          .where(and(eq(trailers.organizationId, ctx.orgId), eq(trailers.status, "active")))
          .orderBy(asc(trailers.unitNumber)),
        tx
          .select({ id: partners.id, label: partners.name, type: partners.type })
          .from(partners)
          .where(and(eq(partners.organizationId, ctx.orgId), eq(partners.status, "active")))
          .orderBy(asc(partners.name)),
      ]);
      return { drivers: d, trucks: t, trailers: tr, partners: p };
    }),
  ),
});
