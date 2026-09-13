import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "@corridor/db";
import { collectCustomsWatchdog } from "./services/customs-watchdog";
import { collectReadiness } from "./services/readiness";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const conn = createDb(DB_URL, { max: 1 });

afterAll(() => conn.sql.end());

describe("operational observability queries", () => {
  it("collects a redacted readiness snapshot without contacting the provider receive endpoint", async () => {
    const result = await collectReadiness(conn.db, {
      env: { VERCEL_ENV: "development" },
      now: new Date(),
    });

    expect(result.checks.postgres.ok).toBe(true);
    expect(result.checks.jobs.queueDepth).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toMatch(/\brequestPayload\b|\bresponsePayload\b|\bcompanyKey\b/i);
  });

  it("collects grouped watchdog counts from the production schema", async () => {
    const result = await collectCustomsWatchdog(conn.db);

    expect(result.snapshot.queueDepth).toBeGreaterThanOrEqual(0);
    expect(result.conditions.every((condition) => condition.count > 0)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/organizationId|movementId|payload/i);
  });
});
