import { describe, expect, it } from "vitest";
import { evaluateReadiness, type ReadinessSnapshot } from "./readiness";

const NOW = new Date("2026-09-13T12:00:00.000Z");

function healthy(overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
  return {
    postgresOk: true,
    redis: { configured: false, ok: true },
    liveBorderConnectConfigs: 0,
    queueDepth: 0,
    oldestJobAgeMs: 0,
    overdueJobs: 0,
    expiredLeases: 0,
    failedDrainJobs: 0,
    lastSuccessfulDrainAt: null,
    waitingSubmissions: 0,
    lastProviderActivityAt: null,
    ...overrides,
  };
}

const productionEnv = {
  VERCEL_ENV: "production",
  DATABASE_URL: "configured",
  NEXT_PUBLIC_SUPABASE_URL: "configured",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "configured",
  SUPABASE_SERVICE_ROLE_KEY: "configured",
  CRON_SECRET: "configured",
  READINESS_SECRET: "configured",
  SENTRY_DSN: "configured",
};

describe("evaluateReadiness", () => {
  it("reports redacted production configuration gaps and requires BorderConnect secrets only when live", () => {
    const result = evaluateReadiness(healthy({ liveBorderConnectConfigs: 1 }), {
      env: { VERCEL_ENV: "production", DATABASE_URL: "configured" },
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.checks.configuration.missing).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "CRON_SECRET",
      "READINESS_SECRET",
      "SENTRY_DSN",
      "BORDERCONNECT_API_URL_SUFFIX",
      "BORDERCONNECT_API_KEY",
      "BORDERCONNECT_SPOOL_DIR",
      "BORDERCONNECT_SPOOL_KEY",
    ]);
    expect(JSON.stringify(result)).not.toContain(':"configured"');
  });

  it("does not require a drain or provider activity when no live BorderConnect config is active", () => {
    const result = evaluateReadiness(healthy(), { env: productionEnv, now: NOW });

    expect(result.ok).toBe(true);
    expect(result.checks.borderConnectDrain.status).toBe("not_required");
    expect(result.checks.providerActivity.status).toBe("idle");
  });

  it("fails when job leases are expired or due work is stale", () => {
    const result = evaluateReadiness(
      healthy({ queueDepth: 4, oldestJobAgeMs: 240_000, overdueJobs: 2, expiredLeases: 1 }),
      { env: productionEnv, now: NOW },
    );

    expect(result.ok).toBe(false);
    expect(result.checks.jobs).toMatchObject({
      ok: false,
      queueDepth: 4,
      overdue: 2,
      expiredLeases: 1,
      oldestAgeSeconds: 240,
    });
  });

  it("fails when the oldest pending or running job exceeds the freshness budget", () => {
    const result = evaluateReadiness(healthy({ queueDepth: 1, oldestJobAgeMs: 120_001 }), {
      env: productionEnv,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.checks.jobs).toMatchObject({ ok: false, queueDepth: 1, oldestAgeSeconds: 120 });
  });

  it("fails live readiness for a stale drain or no recent activity while submissions wait", () => {
    const result = evaluateReadiness(
      healthy({
        liveBorderConnectConfigs: 1,
        lastSuccessfulDrainAt: new Date(NOW.getTime() - 4 * 60_000),
        waitingSubmissions: 2,
        lastProviderActivityAt: new Date(NOW.getTime() - 11 * 60_000),
      }),
      {
        env: {
          ...productionEnv,
          BORDERCONNECT_API_URL_SUFFIX: "private",
          BORDERCONNECT_API_KEY: "private",
          BORDERCONNECT_SPOOL_DIR: "private",
          BORDERCONNECT_SPOOL_KEY: "private",
        },
        now: NOW,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.checks.borderConnectDrain).toMatchObject({ ok: false, status: "stale" });
    expect(result.checks.providerActivity).toMatchObject({ ok: false, status: "stale" });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("fails live readiness when an active tenant has no BorderConnect company key", () => {
    const result = evaluateReadiness(
      healthy({
        liveBorderConnectConfigs: 1,
        missingBorderConnectCompanyKeys: 1,
        lastSuccessfulDrainAt: NOW,
      }),
      {
        env: {
          ...productionEnv,
          BORDERCONNECT_API_URL_SUFFIX: "configured",
          BORDERCONNECT_API_KEY: "configured",
          BORDERCONNECT_SPOOL_DIR: "/var/lib/corridor/spool",
          BORDERCONNECT_SPOOL_KEY: "configured",
        },
        now: NOW,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.checks.configuration).toMatchObject({
      ok: false,
      missing: ["BORDERCONNECT_COMPANY_KEY"],
      missingBorderConnectCompanyKeys: 1,
    });
  });
});
