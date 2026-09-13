import { sql, withServiceRole, type DatabaseClient } from "@corridor/db";
import { corridorMetrics } from "@corridor/observability";
import { getRedis } from "../infra/redis";

const JOB_STALE_MS = 2 * 60_000;
const DRAIN_STALE_MS = 3 * 60_000;
const PROVIDER_STALE_MS = 10 * 60_000;

export interface ReadinessSnapshot {
  postgresOk: boolean;
  redis: { configured: boolean; ok: boolean };
  liveBorderConnectConfigs: number;
  missingBorderConnectCompanyKeys?: number;
  queueDepth: number;
  oldestJobAgeMs: number;
  overdueJobs: number;
  expiredLeases: number;
  failedDrainJobs: number;
  lastSuccessfulDrainAt: Date | null;
  waitingSubmissions: number;
  lastProviderActivityAt: Date | null;
}

export interface ReadinessResult {
  ok: boolean;
  service: "corridor-web";
  at: string;
  checks: {
    postgres: { ok: boolean };
    redis: { ok: boolean; configured: boolean };
    configuration: {
      ok: boolean;
      missing: string[];
      missingBorderConnectCompanyKeys: number;
    };
    jobs: {
      ok: boolean;
      queueDepth: number;
      oldestAgeSeconds: number;
      overdue: number;
      expiredLeases: number;
    };
    borderConnectDrain: {
      ok: boolean;
      status: "not_required" | "healthy" | "missing" | "stale" | "failed";
      ageSeconds: number | null;
    };
    providerActivity: {
      ok: boolean;
      status: "idle" | "recent" | "missing" | "stale";
      ageSeconds: number | null;
      waitingSubmissions: number;
    };
  };
}

const REQUIRED_PRODUCTION_ENV = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
  "SENTRY_DSN",
] as const;

function ageMs(value: Date | null, now: Date): number | null {
  return value ? Math.max(0, now.getTime() - value.getTime()) : null;
}

export function evaluateReadiness(
  snapshot: ReadinessSnapshot,
  opts: { env?: NodeJS.ProcessEnv | Record<string, string | undefined>; now?: Date } = {},
): ReadinessResult {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const production = env.VERCEL_ENV === "production" || env.CORRIDOR_ENV === "production";
  const missing: string[] = production ? REQUIRED_PRODUCTION_ENV.filter((name) => !env[name]) : [];
  if (snapshot.liveBorderConnectConfigs > 0) {
    for (const name of ["BORDERCONNECT_API_URL_SUFFIX", "BORDERCONNECT_API_KEY"] as const) {
      if (!env[name]) missing.push(name);
    }
    if (!env.BORDERCONNECT_SPOOL_DIR) missing.push("BORDERCONNECT_SPOOL_DIR");
    if (!env.BORDERCONNECT_SPOOL_KEY) missing.push("BORDERCONNECT_SPOOL_KEY");
  }
  const missingCompanyKeys = snapshot.missingBorderConnectCompanyKeys ?? 0;
  if (missingCompanyKeys > 0) missing.push("BORDERCONNECT_COMPANY_KEY");
  const redisPartiallyConfigured = Boolean(
    env.UPSTASH_REDIS_REST_URL || env.UPSTASH_REDIS_REST_TOKEN,
  );
  if (production && redisPartiallyConfigured) {
    if (!env.UPSTASH_REDIS_REST_URL) missing.push("UPSTASH_REDIS_REST_URL");
    if (!env.UPSTASH_REDIS_REST_TOKEN) missing.push("UPSTASH_REDIS_REST_TOKEN");
  }

  const jobsOk =
    snapshot.overdueJobs === 0 &&
    snapshot.expiredLeases === 0 &&
    (snapshot.queueDepth === 0 || snapshot.oldestJobAgeMs <= JOB_STALE_MS);
  const drainAge = ageMs(snapshot.lastSuccessfulDrainAt, now);
  const drainRequired = snapshot.liveBorderConnectConfigs > 0;
  const drainStatus = !drainRequired
    ? "not_required"
    : snapshot.failedDrainJobs > 0
      ? "failed"
      : drainAge === null
        ? "missing"
        : drainAge > DRAIN_STALE_MS
          ? "stale"
          : "healthy";
  const providerAge = ageMs(snapshot.lastProviderActivityAt, now);
  const providerStatus =
    snapshot.waitingSubmissions === 0
      ? "idle"
      : providerAge === null
        ? "missing"
        : providerAge > PROVIDER_STALE_MS
          ? "stale"
          : "recent";

  const checks: ReadinessResult["checks"] = {
    postgres: { ok: snapshot.postgresOk },
    redis: snapshot.redis,
    configuration: {
      ok: missing.length === 0,
      missing,
      missingBorderConnectCompanyKeys: missingCompanyKeys,
    },
    jobs: {
      ok: jobsOk,
      queueDepth: snapshot.queueDepth,
      oldestAgeSeconds: Math.round(snapshot.oldestJobAgeMs / 1000),
      overdue: snapshot.overdueJobs,
      expiredLeases: snapshot.expiredLeases,
    },
    borderConnectDrain: {
      ok: drainStatus === "not_required" || drainStatus === "healthy",
      status: drainStatus,
      ageSeconds: drainAge === null ? null : Math.round(drainAge / 1000),
    },
    providerActivity: {
      ok: providerStatus === "idle" || providerStatus === "recent",
      status: providerStatus,
      ageSeconds: providerAge === null ? null : Math.round(providerAge / 1000),
      waitingSubmissions: snapshot.waitingSubmissions,
    },
  };
  return {
    ok: Object.values(checks).every((check) => check.ok),
    service: "corridor-web",
    at: now.toISOString(),
    checks,
  };
}

interface ReadinessDbRow extends Record<string, unknown> {
  live_borderconnect_configs: number;
  missing_borderconnect_company_keys: number;
  queue_depth: number;
  oldest_job_age_ms: number;
  overdue_jobs: number;
  expired_leases: number;
  failed_drain_jobs: number;
  last_successful_drain_at: Date | string | null;
  waiting_submissions: number;
  last_provider_activity_at: Date | string | null;
}

function dateOrNull(value: Date | string | null): Date | null {
  return value ? new Date(value) : null;
}

async function redisReadiness(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<ReadinessSnapshot["redis"]> {
  const configured = Boolean(env.UPSTASH_REDIS_REST_URL || env.UPSTASH_REDIS_REST_TOKEN);
  if (!configured) return { configured: false, ok: true };
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN)
    return { configured: true, ok: false };
  try {
    const redis = getRedis();
    if (!redis) return { configured: true, ok: false };
    await redis.ping();
    return { configured: true, ok: true };
  } catch {
    return { configured: true, ok: false };
  }
}

export async function collectReadiness(
  db: DatabaseClient,
  opts: { env?: NodeJS.ProcessEnv | Record<string, string | undefined>; now?: Date } = {},
): Promise<ReadinessResult> {
  const env = opts.env ?? process.env;
  const redis = await redisReadiness(env);
  let snapshot: ReadinessSnapshot = {
    postgresOk: false,
    redis,
    liveBorderConnectConfigs: 0,
    missingBorderConnectCompanyKeys: 0,
    queueDepth: 0,
    oldestJobAgeMs: 0,
    overdueJobs: 0,
    expiredLeases: 0,
    failedDrainJobs: 0,
    lastSuccessfulDrainAt: null,
    waitingSubmissions: 0,
    lastProviderActivityAt: null,
  };

  try {
    const rows = await withServiceRole(db, (tx) =>
      tx.execute<ReadinessDbRow>(sql`
        select
          (select count(*)::int from public.integration_configs
            where mode = 'border_connect' and environment = 'production' and status = 'active') as live_borderconnect_configs,
          (select count(*)::int from public.integration_configs c
            join public.organizations o on o.id = c.organization_id
            where c.mode = 'border_connect' and c.environment = 'production' and c.status = 'active'
              and o.border_connect_company_key is null) as missing_borderconnect_company_keys,
          (select count(*)::int from public.background_jobs
            where status in ('pending', 'running')) as queue_depth,
          (select coalesce(extract(epoch from (now() - min(created_at))) * 1000, 0)::bigint
            from public.background_jobs where status in ('pending', 'running')) as oldest_job_age_ms,
          (select count(*)::int from public.background_jobs
            where status = 'pending' and run_at < now() - interval '2 minutes') as overdue_jobs,
          (select count(*)::int from public.background_jobs
            where status = 'running' and lease_expires_at < now()) as expired_leases,
          (select count(*)::int from public.background_jobs
            where job_type = 'customs.borderconnect_drain' and status = 'failed'
              and created_at > now() - interval '10 minutes') as failed_drain_jobs,
          (select max(finished_at) from public.background_jobs
            where job_type = 'customs.borderconnect_drain' and status = 'succeeded') as last_successful_drain_at,
          (select count(*)::int from public.customs_submissions
            where mode = 'border_connect' and status in ('sent', 'acknowledged')) as waiting_submissions,
          (select max(e.created_at) from public.integration_events e
            where e.provider in ('cbp_ace', 'cbsa_aci')
              and exists (
                select 1 from public.customs_submissions s
                where s.organization_id = e.organization_id
                  and s.movement_id is not distinct from e.movement_id
                  and s.mode = 'border_connect'
                  and s.status in ('sent', 'acknowledged')
                  and e.created_at >= s.created_at
              )) as last_provider_activity_at
      `),
    );
    const row = rows[0];
    if (!row) throw new Error("readiness query returned no row");
    snapshot = {
      postgresOk: true,
      redis,
      liveBorderConnectConfigs: Number(row.live_borderconnect_configs),
      missingBorderConnectCompanyKeys: Number(row.missing_borderconnect_company_keys),
      queueDepth: Number(row.queue_depth),
      oldestJobAgeMs: Number(row.oldest_job_age_ms),
      overdueJobs: Number(row.overdue_jobs),
      expiredLeases: Number(row.expired_leases),
      failedDrainJobs: Number(row.failed_drain_jobs),
      lastSuccessfulDrainAt: dateOrNull(row.last_successful_drain_at),
      waitingSubmissions: Number(row.waiting_submissions),
      lastProviderActivityAt: dateOrNull(row.last_provider_activity_at),
    };
  } catch {
    // The public response deliberately carries no driver error or connection detail.
  }

  corridorMetrics.jobQueue({ depth: snapshot.queueDepth, oldestAgeMs: snapshot.oldestJobAgeMs });
  return evaluateReadiness(snapshot, { env, now: opts.now });
}

export { JOB_STALE_MS };
