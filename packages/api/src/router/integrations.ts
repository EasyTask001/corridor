import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, schema, sql, withServiceRole } from "@corridor/db";
import { uuid } from "@corridor/domain";
import { getBorderWait, lookupHsCode, searchTariff } from "@corridor/integrations";
import { permissionProcedure, router } from "../trpc";
import { isSafeGatewayBaseUrl } from "@corridor/integrations";
import { writeAudit } from "../services/audit";
import { customsClientFor } from "../services/customs";
import { enqueueJob, processDueJobs } from "../services/jobs";

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
          /**
           * 0023 — mock gateway, or the certified EDI gateway's REST API.
           * 0047 adds `border_connect` — BorderConnect's Service Provider
           * eManifest API, which has no per-org base URL (see `baseUrl` below).
           */
          mode: z.enum(["mock", "gateway", "border_connect"]).default("mock"),
          baseUrl: z
            .string()
            .trim()
            .url()
            .max(300)
            .refine(isSafeGatewayBaseUrl, "Gateway URL must be an HTTPS public endpoint")
            .nullable()
            .optional(),
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
        // BorderConnect has no per-org base URL — it's addressed by the
        // deployment-wide BORDERCONNECT_API_URL_SUFFIX env var and the org's
        // company key, not a tenant-supplied gateway URL. Force it server-side
        // rather than trusting the client to have left it blank.
        const baseUrl = input.mode === "border_connect" ? null : (input.baseUrl ?? null);

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
              baseUrl,
            })
            .onConflictDoUpdate({
              target: [integrationConfigs.organizationId, integrationConfigs.provider],
              set: {
                environment: input.environment,
                status: input.status,
                settings: input.settings,
                mode: input.mode,
                baseUrl,
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

  /**
   * "Test connection" on the integrations page: GET /manifests/ping (or the
   * fixture / mock) — except in `border_connect` mode, where there is no
   * synchronous ping to make (BorderConnect answers through the shared
   * inbox, not a request/response round trip): this drains it instead, the
   * same job `customs.borderconnect_drain` runs every minute.
   *
   * The drain is NOT called directly here. BorderConnect's inbox is one queue
   * shared by every tenant, and `processInboxRow` writes `customs_event` and
   * `pars_rns_events` rows that no compare-and-swap dedupes — so a click
   * racing the cron (or a second click) could double-log another tenant's
   * message and burn the shared BorderConnect rate limit for everyone. This
   * goes through exactly the mechanism the cron route uses
   * (`apps/web/src/app/api/jobs/borderconnect-drain/route.ts`): enqueue
   * `customs.borderconnect_drain` under a per-minute idempotency key, then let
   * `claim_jobs`'s lock decide who actually runs it. A click in the same
   * minute as the cron's own enqueue finds the job already claimed and reports
   * that rather than draining a second time.
   *
   * Unlike `jobs.runNow` below, the `processDueJobs` call is deliberately NOT
   * scoped to `ctx.orgId`: the drain job is queue-wide (`organization_id` is
   * null — it has no tenant until each message is routed by `companyKey`), so
   * an org-scoped claim could never pick it up. Only this job's own counts are
   * reported back; another tenant's job result is never returned.
   *
   * Two-transaction shape, like `jobs.runNow` above: read the config in one
   * `ctx.rls`, enqueue/run on `ctx.db` with no RLS transaction open
   * (`withServiceRole` must never nest inside one, packages/db/src/rls.ts),
   * then audit in a second `ctx.rls`.
   */
  testCustoms: permissionProcedure("integrations.manage")
    .input(z.object({ provider: z.enum(["cbp_ace", "cbsa_aci"]) }))
    .mutation(async ({ ctx, input }) => {
      const regime = input.provider === "cbp_ace" ? "ACE" : "ACI";
      const started = Date.now();
      const prepared = await ctx.rls(async (tx) => {
        const { client } = await customsClientFor(tx, ctx.orgId, regime);
        if (client.mode === "border_connect") return { deferred: true as const };
        try {
          return { deferred: false as const, result: await client.ping() };
        } catch (e) {
          return {
            deferred: false as const,
            result: {
              ok: false,
              mode: client.mode,
              live: false,
              detail: null,
              error: e instanceof Error ? e.message : String(e),
            },
          };
        }
      });

      let result: { ok: boolean; mode: string; live: boolean; detail: unknown; error?: string };
      if (prepared.deferred) {
        // No RLS transaction is open here — the ctx.rls above already
        // committed — so the enqueue and the job worker are free to open their
        // own withServiceRole transactions.
        const { borderConnectEnv } = await import("../services/borderconnect");
        try {
          // `background_jobs_insert` refuses this job type from any session
          // (migration 0047), so the enqueue itself must be service-role.
          const job = await withServiceRole(ctx.db, (tx) =>
            enqueueJob(tx, {
              orgId: null,
              jobType: "customs.borderconnect_drain",
              payload: {},
              idempotencyKey: `bc-drain:${new Date().toISOString().slice(0, 16)}`,
              maxAttempts: 2,
            }),
          );
          const run = await processDueJobs(ctx.db, {
            limit: 5,
            worker: `manual-bc-${ctx.session.user.id.slice(0, 8)}`,
          });
          // Only this job's counts — never another tenant's job result.
          const drain = run.results.find((r) => r.id === job.id);
          const counts = drain?.result as { received?: number; stored?: number } | undefined;
          result = {
            ok: drain ? drain.ok : true,
            mode: "border_connect",
            live: borderConnectEnv().live,
            detail: drain
              ? { jobId: job.id, received: counts?.received ?? 0, stored: counts?.stored ?? 0 }
              : { jobId: job.id, alreadyRunning: true },
            ...(drain?.error ? { error: drain.error } : {}),
          };
        } catch (e) {
          result = {
            ok: false,
            mode: "border_connect",
            live: borderConnectEnv().live,
            detail: null,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      } else {
        result = prepared.result;
      }

      await ctx.rls((tx) =>
        writeAudit(
          tx,
          ctx.orgId,
          "integration.test_connection",
          "integration_config",
          input.provider,
          null,
          { ok: result.ok, mode: result.mode, live: result.live, error: result.error ?? null },
        ),
      );
      return { ...result, durationMs: Date.now() - started };
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
      const summary = {
        claimed: result.claimed,
        succeeded: result.succeeded,
        failed: result.failed,
      };
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
        return Object.fromEntries(rows.map((r) => [r.status, r.count]));
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
