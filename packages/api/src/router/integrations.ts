import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, schema, sql } from "@corridor/db";
import { uuid } from "@corridor/domain";
import { getBorderWait, lookupHsCode, searchTariff } from "@corridor/integrations";
import { permissionProcedure, router } from "../trpc";
import { writeAudit } from "../services/audit";
import { customsClientFor } from "../services/customs";
import { processDueJobs } from "../services/jobs";

const { integrationConfigs, integrationEvents, backgroundJobs, movements } = schema;

const provider = z.enum(["cbp_ace", "cbsa_aci", "border_wait_time", "hts_tariff", "stripe"]);

/**
 * Everything about a config a client may see. `credentials_ref` (the Vault
 * pointer) is deliberately absent — callers get only `hasCredentials`, and the
 * plaintext is unreachable from an `authenticated` session by construction
 * (see migration 0012's grants on `read_integration_secret`).
 */
const publicConfigColumns = {
  id: integrationConfigs.id,
  organizationId: integrationConfigs.organizationId,
  provider: integrationConfigs.provider,
  environment: integrationConfigs.environment,
  settings: integrationConfigs.settings,
  status: integrationConfigs.status,
  lastError: integrationConfigs.lastError,
  mode: integrationConfigs.mode,
  baseUrl: integrationConfigs.baseUrl,
  lastPolledAt: integrationConfigs.lastPolledAt,
  createdAt: integrationConfigs.createdAt,
  updatedAt: integrationConfigs.updatedAt,
  hasCredentials: sql<boolean>`${integrationConfigs.credentialsRef} is not null`,
};

/** Write-only credential fields. Never echoed back, never audited by value. */
const credentialsInput = z.object({
  apiKey: z.string().trim().max(500).optional(),
  apiSecret: z.string().trim().max(500).optional(),
  accountId: z.string().trim().max(200).optional(),
});

/** Drop blank fields; `undefined` means "the caller sent no credentials". */
function cleanCredentials(input?: z.infer<typeof credentialsInput>) {
  if (!input) return undefined;
  const entries = Object.entries(input).filter(([, v]) => typeof v === "string" && v.length > 0);
  return entries.length > 0 ? (Object.fromEntries(entries) as Record<string, string>) : undefined;
}

export const integrationsRouter = router({
  configs: router({
    list: permissionProcedure("integrations.manage").query(({ ctx }) =>
      ctx.rls((tx) =>
        tx
          .select(publicConfigColumns)
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
          /** 0023 — mock gateway, or the certified EDI gateway's REST API. */
          mode: z.enum(["mock", "gateway"]).default("mock"),
          baseUrl: z.string().trim().url().max(300).nullable().optional(),
          settings: z
            .object({
              mockDelayMs: z.number().int().min(0).max(120_000).optional(),
              mockFailureRate: z.number().min(0).max(1).optional(),
            })
            .default({}),
          credentials: credentialsInput.optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const credentials = cleanCredentials(input.credentials);

        // The config row must exist before store_integration_secret can hang a
        // credentials_ref on it, and the RPC runs on its own connection — so
        // the settings write commits first.
        const { before, row } = await ctx.rls(async (tx) => {
          const [existing] = await tx
            .select(publicConfigColumns)
            .from(integrationConfigs)
            .where(
              and(
                eq(integrationConfigs.organizationId, ctx.orgId),
                eq(integrationConfigs.provider, input.provider),
              ),
            )
            .limit(1);
          const [updated] = await tx
            .insert(integrationConfigs)
            .values({
              organizationId: ctx.orgId,
              provider: input.provider,
              environment: input.environment,
              status: input.status,
              settings: input.settings,
              mode: input.mode,
              baseUrl: input.baseUrl ?? null,
            })
            .onConflictDoUpdate({
              target: [integrationConfigs.organizationId, integrationConfigs.provider],
              set: {
                environment: input.environment,
                status: input.status,
                settings: input.settings,
                mode: input.mode,
                baseUrl: input.baseUrl ?? null,
                lastError: null,
              },
            })
            .returning(publicConfigColumns);
          return { before: existing ?? null, row: updated! };
        });

        let rotated = false;
        if (credentials) {
          // Vault write goes through the SECURITY DEFINER RPC — never a direct
          // insert into vault.* — so the permission check lives in the database.
          const { error } = await ctx.supabase.schema("api").rpc("store_integration_secret", {
            p_org: ctx.orgId,
            p_provider: input.provider,
            p_secret: JSON.stringify(credentials),
          });
          rotated = !error;
        }

        // Audited either way: the settings write above is already committed, so
        // a failed rotation must still leave an honest trail (and never the
        // credential values themselves).
        const after = { ...row, hasCredentials: row.hasCredentials || rotated };
        await ctx.rls((tx) =>
          writeAudit(
            tx,
            ctx.orgId,
            "integration.configure",
            "integration_config",
            input.provider,
            before,
            rotated ? { ...after, credentials_rotated: true } : after,
          ),
        );
        if (credentials && !rotated) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Settings saved, but the credentials for ${input.provider} could not be stored`,
          });
        }
        return after;
      }),
    /** Remove the stored credentials (and the Vault secret itself). */
    clearCredentials: permissionProcedure("integrations.manage")
      .input(z.object({ provider }))
      .mutation(async ({ ctx, input }) => {
        const { data, error } = await ctx.supabase.schema("api").rpc("delete_integration_secret", {
          p_org: ctx.orgId,
          p_provider: input.provider,
        });
        if (error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Could not clear credentials for ${input.provider}`,
          });
        }
        const cleared = data === true;
        if (cleared) {
          await ctx.rls((tx) =>
            writeAudit(
              tx,
              ctx.orgId,
              "integration.credentials_cleared",
              "integration_config",
              input.provider,
              { hasCredentials: true },
              { hasCredentials: false },
            ),
          );
        }
        return { cleared };
      }),
  }),

  /** "Test connection" on the integrations page: GET /manifests/ping (or the fixture / mock). */
  testCustoms: permissionProcedure("integrations.manage")
    .input(z.object({ provider: z.enum(["cbp_ace", "cbsa_aci"]) }))
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const regime = input.provider === "cbp_ace" ? "ACE" : "ACI";
        const { client } = await customsClientFor(tx, ctx.orgId, regime);
        const started = Date.now();
        let result: { ok: boolean; mode: string; live: boolean; detail: unknown; error?: string };
        try {
          result = await client.ping();
        } catch (e) {
          result = {
            ok: false,
            mode: client.mode,
            live: false,
            detail: null,
            error: e instanceof Error ? e.message : String(e),
          };
        }
        await writeAudit(
          tx,
          ctx.orgId,
          "integration.test_connection",
          "integration_config",
          input.provider,
          null,
          { ok: result.ok, mode: result.mode, live: result.live, error: result.error ?? null },
        );
        return { ...result, durationMs: Date.now() - started };
      }),
    ),

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
    /**
     * Run this organization's due jobs now (dev / ops convenience; the cron
     * does this queue-wide in prod). The claim is scoped to ctx.orgId (0041)
     * and only counts come back — never a job's result payload.
     */
    runNow: permissionProcedure("integrations.manage").mutation(async ({ ctx }) => {
      const result = await processDueJobs(ctx.db, {
        worker: `manual-${ctx.session.user.id.slice(0, 8)}`,
        organizationId: ctx.orgId,
      });
      const summary = { claimed: result.claimed, succeeded: result.succeeded, failed: result.failed };
      await ctx.rls((tx) =>
        writeAudit(tx, ctx.orgId, "job.run_now", "background_jobs", ctx.orgId, null, summary),
      );
      return summary;
    }),
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
