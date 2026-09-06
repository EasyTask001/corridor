/**
 * Movement Builder core — headers, cargo, seals, transitions, amendments and
 * the append-only event timeline. Every status change goes through the domain
 * state machine (`transition` / `actorMayTransition`) AND the DB trigger.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  or,
  schema,
  sql,
  type RlsTransaction,
} from "@corridor/db";
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
  transition,
  actorMayTransition,
  uuid,
  validateForTransmit,
  type ActorType,
  type MovementStatus,
} from "@corridor/domain";
import { permissionProcedure, router, type OrgContext } from "../trpc";

const {
  movements,
  movementEvents,
  movementAmendments,
  cargo,
  seals,
  drivers,
  trucks,
  trailers,
  partners,
  userProfiles,
} = schema;

type Tx = RlsTransaction;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function requireMovement(tx: Tx, orgId: string, id: string) {
  const [m] = await tx
    .select()
    .from(movements)
    .where(and(eq(movements.id, id), eq(movements.organizationId, orgId)))
    .limit(1);
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Movement not found" });
  return m;
}

function requireEditable(status: MovementStatus) {
  if (!isEditable(status)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Movement cannot be edited while ${status}`,
    });
  }
}

async function addEvent(
  tx: Tx,
  ctx: OrgContext,
  movementId: string,
  e: {
    eventType: "status_change" | "amendment" | "note" | "customs_response" | "ai_flag";
    fromStatus?: MovementStatus | null;
    toStatus?: MovementStatus | null;
    payload?: Record<string, unknown>;
    actorType: ActorType;
  },
) {
  await tx.insert(movementEvents).values({
    movementId,
    organizationId: ctx.orgId,
    eventType: e.eventType,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    payload: e.payload ?? null,
    actorType: e.actorType,
    actorId: e.actorType === "user" ? ctx.session.user.id : null,
  });
}

/** Apply a status transition with full domain + DB checks, recording the event. */
async function applyTransition(
  tx: Tx,
  ctx: OrgContext,
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
  await addEvent(tx, ctx, m.id, {
    eventType: "status_change",
    fromStatus: from,
    toStatus: to,
    payload,
    actorType,
  });
  return row!;
}

async function loadFull(tx: Tx, orgId: string, id: string) {
  const m = await requireMovement(tx, orgId, id);
  const [driver, truck, trailer, cargoRows, sealRows, events, amendments] = await Promise.all([
    m.driverId
      ? tx
          .select()
          .from(drivers)
          .where(eq(drivers.id, m.driverId))
          .then((r) => r[0] ?? null)
      : null,
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
    tx
      .select({
        cargo: cargo,
        shipperName: sql<
          string | null
        >`(select name from public.partners p where p.id = ${cargo.shipperId})`,
        consigneeName: sql<
          string | null
        >`(select name from public.partners p where p.id = ${cargo.consigneeId})`,
      })
      .from(cargo)
      .where(eq(cargo.movementId, id))
      .orderBy(asc(cargo.lineNumber), asc(cargo.createdAt)),
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
    driver,
    truck,
    trailer,
    cargo: cargoRows.map((r) => ({
      ...r.cargo,
      shipperName: r.shipperName,
      consigneeName: r.consigneeName,
    })),
    seals: sealRows,
    events,
    amendments,
  };
}

type Full = Awaited<ReturnType<typeof loadFull>>;

function toValidation(full: Full) {
  return validateForTransmit({
    regime: full.regime,
    crossingPoint: full.crossingPoint ?? null,
    scheduledCrossingAt: full.scheduledCrossingAt?.toISOString() ?? null,
    driver: full.driver
      ? {
          licenseExpiry: full.driver.licenseExpiry,
          fastCardNumber: full.driver.fastCardNumber,
          fastCardExpiry: full.driver.fastCardExpiry,
          citizenship: full.driver.citizenship,
          status: full.driver.status,
        }
      : null,
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
    cargo: full.cargo.map((c) => ({
      commodityDescription: c.commodityDescription,
      hsCode: c.hsCode,
      weightKg: c.weightKg,
      pieceCount: c.pieceCount,
      shipperId: c.shipperId,
      consigneeId: c.consigneeId,
      valueAmount: c.valueAmount,
      valueCurrency: c.valueCurrency,
      countryOfOrigin: c.countryOfOrigin,
    })),
    seals: full.seals.map((s) => ({ sealNumber: s.sealNumber })),
  });
}

const customsSimulationEnabled = () =>
  process.env.CORRIDOR_ALLOW_CUSTOMS_SIMULATION === "true" || process.env.NODE_ENV !== "production";

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export const movementRouter = router({
  list: permissionProcedure("movement.read")
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
  board: permissionProcedure("movement.read").query(({ ctx }) =>
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

  get: permissionProcedure("movement.read")
    .input(z.object({ id: uuid }))
    .query(({ ctx, input }) => ctx.rls((tx) => loadFull(tx, ctx.orgId, input.id))),

  validate: permissionProcedure("movement.read")
    .input(z.object({ id: uuid }))
    .query(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const full = await loadFull(tx, ctx.orgId, input.id);
        const issues = toValidation(full);
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
        await addEvent(tx, ctx, m!.id, {
          eventType: "status_change",
          fromStatus: null,
          toStatus: "draft",
          actorType: "user",
          payload: { movementNumber },
        });
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
        return row!;
      }),
    ),

  cargo: router({
    upsert: permissionProcedure("movement.write")
      .input(cargoUpsertInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const { id, movementId, ...fields } = input;
          const m = await requireMovement(tx, ctx.orgId, movementId);
          requireEditable(m.status);
          if (id) {
            const [row] = await tx
              .update(cargo)
              .set(fields)
              .where(and(eq(cargo.id, id), eq(cargo.movementId, movementId)))
              .returning();
            if (!row) throw new TRPCError({ code: "NOT_FOUND" });
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
          return row!;
        }),
      ),
    remove: permissionProcedure("movement.write")
      .input(cargoRemoveInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const m = await requireMovement(tx, ctx.orgId, input.movementId);
          requireEditable(m.status);
          await tx
            .delete(cargo)
            .where(and(eq(cargo.id, input.id), eq(cargo.movementId, input.movementId)));
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
          return row!;
        }),
      ),
    remove: permissionProcedure("movement.write")
      .input(sealRemoveInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const m = await requireMovement(tx, ctx.orgId, input.movementId);
          requireEditable(m.status);
          await tx
            .delete(seals)
            .where(and(eq(seals.id, input.id), eq(seals.movementId, input.movementId)));
          return { id: input.id };
        }),
      ),
  }),

  addNote: permissionProcedure("movement.write")
    .input(movementNoteInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        await requireMovement(tx, ctx.orgId, input.movementId);
        await addEvent(tx, ctx, input.movementId, {
          eventType: "note",
          actorType: "user",
          payload: { body: input.body },
        });
        return { ok: true };
      }),
    ),

  /** draft | rejected → sent. Blocked when pre-transmit validation has blocking issues. */
  submit: permissionProcedure("movement.transmit_to_customs")
    .input(z.object({ id: uuid }))
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const full = await loadFull(tx, ctx.orgId, input.id);
        const issues = toValidation(full);
        if (hasBlockingIssues(issues)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Cannot transmit: ${issues
              .filter((i) => i.severity === "blocking")
              .map((i) => i.message)
              .join(" ")}`,
          });
        }
        // Phase 3 wires the real/mocked ACE/ACI client here; Phase 2 records the send.
        return applyTransition(
          tx,
          ctx,
          full,
          "sent",
          "user",
          {},
          {
            regime: full.regime,
            warnings: issues.map((i) => i.code),
          },
        );
      }),
    ),

  cancel: permissionProcedure("movement.cancel")
    .input(z.object({ id: uuid, reason: z.string().trim().max(500).optional() }))
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const m = await requireMovement(tx, ctx.orgId, input.id);
        return applyTransition(
          tx,
          ctx,
          m,
          "cancelled",
          "user",
          {},
          { reason: input.reason ?? null },
        );
      }),
    ),

  /** released → arrived (driver/dispatcher confirms arrival at destination). */
  markArrived: permissionProcedure("movement.write")
    .input(z.object({ id: uuid }))
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const m = await requireMovement(tx, ctx.orgId, input.id);
        return applyTransition(tx, ctx, m, "arrived", "user");
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
        await addEvent(tx, ctx, m.id, {
          eventType: "amendment",
          actorType: "user",
          payload: { amendmentNumber: next, reason: input.reason, diff },
        });
        // One UPDATE: status change + patched fields (the guard permits edits alongside a transition).
        const updated = await applyTransition(tx, ctx, m, "sent", "user", set, {
          amendmentNumber: next,
        });
        return { movement: updated, amendment: amendment! };
      }),
    ),

  /**
   * Customs decision. In Phase 3 this is invoked by the ACE/ACI client
   * callback; in Phase 2 it is a dev-only simulation (disabled in production
   * unless CORRIDOR_ALLOW_CUSTOMS_SIMULATION=true).
   */
  customsResponse: permissionProcedure("movement.transmit_to_customs")
    .input(customsResponseInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        if (!customsSimulationEnabled()) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Customs simulation is disabled" });
        }
        const m = await requireMovement(tx, ctx.orgId, input.movementId);
        const ref =
          input.referenceNumber ??
          m.customsReferenceNumber ??
          `${m.regime}-${Date.now().toString(36).toUpperCase()}`;
        await addEvent(tx, ctx, m.id, {
          eventType: "customs_response",
          actorType: "customs_api",
          payload: {
            decision: input.decision,
            referenceNumber: ref,
            message: input.message ?? null,
            simulated: true,
          },
        });
        const updated = await applyTransition(
          tx,
          ctx,
          m,
          input.decision,
          "customs_api",
          { customsReferenceNumber: ref },
          { referenceNumber: ref, message: input.message ?? null },
        );
        // Resolve any submitted amendment with the same decision.
        if (input.decision === "accepted" || input.decision === "rejected") {
          await tx
            .update(movementAmendments)
            .set({ status: input.decision })
            .where(
              and(
                eq(movementAmendments.movementId, m.id),
                eq(movementAmendments.status, "submitted"),
              ),
            );
        }
        return updated;
      }),
    ),

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
