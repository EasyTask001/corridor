import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, schema, sql } from "@corridor/db";
import { uuid } from "@corridor/domain";
import { getBorderWait, lookupHsCode, searchTariff } from "@corridor/integrations";
import { permissionProcedure, router } from "../trpc";
import { writeAudit } from "../services/audit";
import { processDueJobs } from "../services/jobs";

const { integrationConfigs, integrationEvents, backgroundJobs, movements } = schema;

const provider = z.enum(["cbp_ace", "cbsa_aci", "border_wait_time", "hts_tariff", "stripe"]);

export const integrationsRouter = router({
  configs: router({
    list: permissionProcedure("integrations.manage").query(({ ctx }) =>
      ctx.rls((tx) =>
        tx
          .select()
          .from(integrationConfigs)
          .where(eq(integrationConfigs.organizationId, ctx.orgId))
          .orderBy(integrationConfigs.provider),
      ),
    ),
    upsert: permissionProcedure("integrations.manage")
      .input(
        z.object({
          provider,
          environment: z.enum(["sandbox", "production"]).default("sandbox"),
          status: z.enum(["active", "disabled"]).default("active"),
          settings: z
            .object({
              mockDelayMs: z.number().int().min(0).max(120_000).optional(),
              mockFailureRate: z.number().min(0).max(1).optional(),
            })
            .default({}),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const before = await tx.query.integrationConfigs.findFirst({
            where: and(
              eq(integrationConfigs.organizationId, ctx.orgId),
              eq(integrationConfigs.provider, input.provider),
            ),
          });
          const [row] = await tx
            .insert(integrationConfigs)
            .values({
              organizationId: ctx.orgId,
              provider: input.provider,
              environment: input.environment,
              status: input.status,
              settings: input.settings,
            })
            .onConflictDoUpdate({
              target: [integrationConfigs.organizationId, integrationConfigs.provider],
              set: {
                environment: input.environment,
                status: input.status,
                settings: input.settings,
                lastError: null,
              },
            })
            .returning();
          await writeAudit(
            tx,
            ctx.orgId,
            "integration.configure",
            "integration_config",
            input.provider,
            before,
            row,
          );
          return row!;
        }),
      ),
  }),

  events: router({
    list: permissionProcedure("integrations.manage")
      .input(
        z.object({
          movementId: uuid.optional(),
          limit: z.number().int().min(1).max(200).default(50),
        }),
      )
      .query(({ ctx, input }) =>
        ctx.rls((tx) =>
          tx
            .select({
              id: integrationEvents.id,
              provider: integrationEvents.provider,
              direction: integrationEvents.direction,
              operation: integrationEvents.operation,
              success: integrationEvents.success,
              statusCode: integrationEvents.statusCode,
              errorMessage: integrationEvents.errorMessage,
              durationMs: integrationEvents.durationMs,
              correlationId: integrationEvents.correlationId,
              movementId: integrationEvents.movementId,
              movementNumber: movements.movementNumber,
              createdAt: integrationEvents.createdAt,
            })
            .from(integrationEvents)
            .leftJoin(movements, eq(movements.id, integrationEvents.movementId))
            .where(
              and(
                eq(integrationEvents.organizationId, ctx.orgId),
                input.movementId ? eq(integrationEvents.movementId, input.movementId) : undefined,
              ),
            )
            .orderBy(desc(integrationEvents.createdAt))
            .limit(input.limit),
        ),
      ),
    /** Per-movement history (movement.read is enough — RLS allows it). */
    forMovement: permissionProcedure("movement.read")
      .input(z.object({ movementId: uuid }))
      .query(({ ctx, input }) =>
        ctx.rls((tx) =>
          tx
            .select({
              id: integrationEvents.id,
              provider: integrationEvents.provider,
              direction: integrationEvents.direction,
              operation: integrationEvents.operation,
              success: integrationEvents.success,
              statusCode: integrationEvents.statusCode,
              errorMessage: integrationEvents.errorMessage,
              responsePayload: integrationEvents.responsePayload,
              createdAt: integrationEvents.createdAt,
            })
            .from(integrationEvents)
            .where(
              and(
                eq(integrationEvents.organizationId, ctx.orgId),
                eq(integrationEvents.movementId, input.movementId),
              ),
            )
            .orderBy(desc(integrationEvents.createdAt))
            .limit(50),
        ),
      ),
  }),

  jobs: router({
    list: permissionProcedure("integrations.manage")
      .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
      .query(({ ctx, input }) =>
        ctx.rls((tx) =>
          tx
            .select()
            .from(backgroundJobs)
            .where(eq(backgroundJobs.organizationId, ctx.orgId))
            .orderBy(desc(backgroundJobs.createdAt))
            .limit(input.limit),
        ),
      ),
    /** Run due jobs now (dev / ops convenience; the cron does this in prod). */
    runNow: permissionProcedure("integrations.manage").mutation(({ ctx }) =>
      processDueJobs(ctx.db, { worker: `manual-${ctx.session.user.id.slice(0, 8)}` }),
    ),
    stats: permissionProcedure("integrations.manage").query(({ ctx }) =>
      ctx.rls(async (tx) => {
        const rows = await tx
          .select({ status: backgroundJobs.status, count: sql<number>`count(*)::int` })
          .from(backgroundJobs)
          .where(eq(backgroundJobs.organizationId, ctx.orgId))
          .groupBy(backgroundJobs.status);
        return Object.fromEntries(rows.map((r) => [r.status, r.count])) as Record<string, number>;
      }),
    ),
  }),

  borderWait: permissionProcedure("movement.read")
    .input(z.object({ crossingCode: z.string().trim().min(3).max(4) }))
    .query(({ input }) => getBorderWait(input.crossingCode)),

  tariff: router({
    lookup: permissionProcedure("movement.read")
      .input(z.object({ hsCode: z.string().trim().max(12) }))
      .query(({ input }) => lookupHsCode(input.hsCode)),
    search: permissionProcedure("movement.read")
      .input(z.object({ q: z.string().trim().max(60) }))
      .query(({ input }) => searchTariff(input.q)),
  }),

  _guard: permissionProcedure("integrations.manage").query(() => {
    throw new TRPCError({ code: "NOT_IMPLEMENTED" });
  }),
});
