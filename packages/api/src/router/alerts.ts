import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, schema, sql } from "@corridor/db";
import { alertListInput, alertStatus, canTransitionAlert, uuid } from "@corridor/domain";
import { permissionProcedure, router } from "../trpc";
import { scanOrganization } from "../services/compliance";

const { complianceAlerts, drivers, trucks, trailers, movements } = schema;

export const alertsRouter = router({
  list: permissionProcedure("alert.read")
    .input(alertListInput)
    .query(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const conds = [
          eq(complianceAlerts.organizationId, ctx.orgId),
          inArray(complianceAlerts.status, input.status),
        ];
        if (input.severity?.length) conds.push(inArray(complianceAlerts.severity, input.severity));
        if (input.alertType?.length)
          conds.push(inArray(complianceAlerts.alertType, input.alertType));
        if (input.entity?.driverId)
          conds.push(eq(complianceAlerts.driverId, input.entity.driverId));
        if (input.entity?.truckId) conds.push(eq(complianceAlerts.truckId, input.entity.truckId));
        if (input.entity?.trailerId)
          conds.push(eq(complianceAlerts.trailerId, input.entity.trailerId));
        if (input.entity?.movementId)
          conds.push(eq(complianceAlerts.movementId, input.entity.movementId));
        const where = and(...conds);

        const [rows, counts] = await Promise.all([
          tx
            .select({
              id: complianceAlerts.id,
              alertType: complianceAlerts.alertType,
              severity: complianceAlerts.severity,
              status: complianceAlerts.status,
              title: complianceAlerts.title,
              description: complianceAlerts.description,
              dueAt: complianceAlerts.dueAt,
              source: complianceAlerts.source,
              metadata: complianceAlerts.metadata,
              driverId: complianceAlerts.driverId,
              truckId: complianceAlerts.truckId,
              trailerId: complianceAlerts.trailerId,
              movementId: complianceAlerts.movementId,
              createdAt: complianceAlerts.createdAt,
              updatedAt: complianceAlerts.updatedAt,
              driverName: sql<string | null>`${drivers.firstName} || ' ' || ${drivers.lastName}`,
              truckUnit: trucks.unitNumber,
              trailerUnit: trailers.unitNumber,
              movementNumber: movements.movementNumber,
            })
            .from(complianceAlerts)
            .leftJoin(drivers, eq(drivers.id, complianceAlerts.driverId))
            .leftJoin(trucks, eq(trucks.id, complianceAlerts.truckId))
            .leftJoin(trailers, eq(trailers.id, complianceAlerts.trailerId))
            .leftJoin(movements, eq(movements.id, complianceAlerts.movementId))
            .where(where)
            .orderBy(
              sql`case ${complianceAlerts.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`,
              complianceAlerts.dueAt,
              desc(complianceAlerts.createdAt),
            )
            .limit(input.limit)
            .offset(input.offset),
          tx
            .select({ count: sql<number>`count(*)::int` })
            .from(complianceAlerts)
            .where(where),
        ]);
        return { rows, total: counts[0]?.count ?? 0 };
      }),
    ),

  /** Counts for the dashboard / nav badge. */
  summary: permissionProcedure("alert.read").query(({ ctx }) =>
    ctx.rls(async (tx) => {
      const rows = await tx
        .select({
          severity: complianceAlerts.severity,
          count: sql<number>`count(*)::int`,
        })
        .from(complianceAlerts)
        .where(
          and(
            eq(complianceAlerts.organizationId, ctx.orgId),
            inArray(complianceAlerts.status, ["open", "acknowledged"]),
          ),
        )
        .groupBy(complianceAlerts.severity);
      const out = { critical: 0, warning: 0, info: 0, total: 0 };
      for (const r of rows) {
        out[r.severity] = r.count;
        out.total += r.count;
      }
      return out;
    }),
  ),

  setStatus: permissionProcedure("alert.manage")
    .input(z.object({ id: uuid, status: alertStatus }))
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const [current] = await tx
          .select({ status: complianceAlerts.status })
          .from(complianceAlerts)
          .where(
            and(eq(complianceAlerts.id, input.id), eq(complianceAlerts.organizationId, ctx.orgId)),
          );
        if (!current) throw new TRPCError({ code: "NOT_FOUND" });
        if (!canTransitionAlert(current.status, input.status)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cannot move alert from ${current.status} to ${input.status}`,
          });
        }
        const now = sql`now()`;
        const [row] = await tx
          .update(complianceAlerts)
          .set({
            status: input.status,
            ...(input.status === "acknowledged" && {
              acknowledgedBy: ctx.session.user.id,
              acknowledgedAt: now,
            }),
            ...((input.status === "resolved" || input.status === "dismissed") && {
              resolvedBy: ctx.session.user.id,
              resolvedAt: now,
            }),
            ...(input.status === "open" && { resolvedBy: null, resolvedAt: null }),
          })
          .where(eq(complianceAlerts.id, input.id))
          .returning({ id: complianceAlerts.id, status: complianceAlerts.status });
        return row!;
      }),
    ),

  /** Manual re-scan for the active org (the nightly cron does this for every org). */
  rescan: permissionProcedure("alert.manage").mutation(({ ctx }) =>
    ctx.rls((tx) => scanOrganization(tx, ctx.orgId)),
  ),
});
