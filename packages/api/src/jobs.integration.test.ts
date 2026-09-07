/**
 * DB-backed tests for the `billing.report_usage` job body
 * (`services/usage.ts` → `reportPendingUsage`, dispatched by `services/jobs.ts`).
 *
 * Everything the unit tests cannot reach lives here: which rows the settling
 * window selects, that the per-org batching really isolates one tenant's
 * failure from another's, and that the stamped row is genuinely idempotent on
 * a second run.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/api test:integration
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, eq, inArray, schema, withServiceRole } from "@corridor/db";
import { reportUsage, type UsageMeterRecord } from "@corridor/integrations";
import { reportPendingUsage } from "./services/usage";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

const conn = createDb(DB_URL, { max: 4 });
const db = conn.db;
const { organizations, usageRecords } = schema;

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

/** Run the job body the way `services/jobs.ts` does: service role, real reporter. */
function run(report?: (r: UsageMeterRecord[]) => Promise<Array<{ id: number; eventId: string }>>) {
  return withServiceRole(db, (tx) => reportPendingUsage(tx, report));
}

/** Two throwaway orgs: one that reached Stripe checkout, one that never did. */
let billedOrg: string;
let unbilledOrg: string;

beforeAll(async () => {
  const rows = await db
    .insert(organizations)
    .values([
      { name: `Usage Billed ${Date.now()}`, stripeCustomerId: `cus_test_${Date.now()}` },
      { name: `Usage Unbilled ${Date.now()}`, stripeCustomerId: null },
    ])
    .returning({ id: organizations.id });
  billedOrg = rows[0]!.id;
  unbilledOrg = rows[1]!.id;
  // Settle anything another suite left pending so the whole-queue counts these
  // tests assert on (`reported`, `organizations`) describe only our own rows.
  await run();
});

afterEach(async () => {
  await withServiceRole(db, (tx) =>
    tx.delete(usageRecords).where(inArray(usageRecords.organizationId, [billedOrg, unbilledOrg])),
  );
});

afterAll(async () => {
  // cascades into usage_records
  await db.delete(organizations).where(inArray(organizations.id, [billedOrg, unbilledOrg]));
  await conn.sql.end();
});

/** Seed one meter row directly (service role); returns its id. */
async function seed(
  orgId: string,
  occurredAt: Date,
  metric: "documents_extracted" | "copilot_messages" = "documents_extracted",
  quantity = 1,
) {
  const [row] = await withServiceRole(db, (tx) =>
    tx
      .insert(usageRecords)
      .values({
        organizationId: orgId,
        metric,
        quantity,
        occurredAt,
        periodStart: `${occurredAt.getUTCFullYear()}-${String(occurredAt.getUTCMonth() + 1).padStart(2, "0")}-01`,
        metadata: { seededBy: "jobs.integration.test" },
      })
      .returning({ id: usageRecords.id }),
  );
  return row!.id;
}

async function rowsFor(ids: number[]) {
  const rows = await withServiceRole(db, (tx) =>
    tx
      .select({
        id: usageRecords.id,
        reportedAt: usageRecords.reportedAt,
        eventId: usageRecords.stripeMeterEventId,
      })
      .from(usageRecords)
      .where(inArray(usageRecords.id, ids)),
  );
  return new Map(rows.map((r) => [r.id, r]));
}

describe("billing.report_usage", () => {
  it("settles records older than the window and leaves recent ones alone", async () => {
    // No STRIPE_SECRET_KEY in this environment, so the real reporter runs in
    // mock mode — the same graceful-degradation path CI and local dev take.
    const oldBilled = await seed(billedOrg, ago(3 * HOUR));
    const oldUnbilled = await seed(unbilledOrg, ago(2 * HOUR), "copilot_messages", 5);
    const recent = await seed(billedOrg, ago(5 * 60_000));

    const result = await run();
    expect(result.failures).toEqual([]);
    expect(result.organizations).toBe(2);
    expect(result.reported).toBe(2);

    const rows = await rowsFor([oldBilled, oldUnbilled, recent]);
    // Mock mode has no Stripe client at all, so even the org with a customer id
    // settles with a synthetic id — `unbilled_` only appears with a real key.
    expect(rows.get(oldBilled)!.reportedAt).not.toBeNull();
    expect(rows.get(oldBilled)!.eventId).toMatch(/^mock_[0-9a-f-]{36}$/);
    expect(rows.get(oldUnbilled)!.reportedAt).not.toBeNull();
    expect(rows.get(oldUnbilled)!.eventId).toMatch(/^mock_[0-9a-f-]{36}$/);
    // Still inside the settling window: untouched.
    expect(rows.get(recent)!.reportedAt).toBeNull();
    expect(rows.get(recent)!.eventId).toBeNull();
  });

  it("distinguishes a billable org from one with no Stripe customer", async () => {
    // Drive the reporter with a Stripe-mode stub so the `unbilled` branch —
    // unreachable without a secret key — is actually exercised.
    const billed = await seed(billedOrg, ago(3 * HOUR));
    const unbilled = await seed(unbilledOrg, ago(3 * HOUR));

    const seen: UsageMeterRecord[] = [];
    const result = await run(async (records) => {
      seen.push(...records);
      return records.map((r) => ({
        id: r.id,
        eventId: r.stripeCustomerId ? `corridor_usage_${r.id}` : `unbilled_${r.id}`,
      }));
    });
    expect(result.reported).toBe(2);

    // The reporter is handed the org's customer id, or null when it has none.
    expect(seen.find((r) => r.id === billed)!.stripeCustomerId).toMatch(/^cus_test_/);
    expect(seen.find((r) => r.id === unbilled)!.stripeCustomerId).toBeNull();

    const rows = await rowsFor([billed, unbilled]);
    expect(rows.get(billed)!.eventId).toBe(`corridor_usage_${billed}`);
    expect(rows.get(unbilled)!.eventId).toBe(`unbilled_${unbilled}`);
  });

  it("a second run is a no-op and does not re-stamp a settled record", async () => {
    const id = await seed(billedOrg, ago(3 * HOUR));
    const first = await run();
    expect(first.reported).toBe(1);
    const stamped = (await rowsFor([id])).get(id)!;

    const second = await run();
    expect(second).toMatchObject({ reported: 0, organizations: 0, failures: [] });

    const again = (await rowsFor([id])).get(id)!;
    expect(again.eventId).toBe(stamped.eventId);
    expect(again.reportedAt).toEqual(stamped.reportedAt);
  });

  it("one org's reporter failure does not strand another org's records", async () => {
    const billed = await seed(billedOrg, ago(3 * HOUR));
    const unbilledA = await seed(unbilledOrg, ago(3 * HOUR));
    const unbilledB = await seed(unbilledOrg, ago(2 * HOUR));

    const result = await run(async (records) => {
      if (records[0]!.organizationId === billedOrg) {
        throw new Error("stripe is down for this customer");
      }
      return reportUsage(records);
    });

    expect(result.organizations).toBe(2);
    expect(result.reported).toBe(2); // the healthy org's two rows
    expect(result.failures).toEqual([
      { organizationId: billedOrg, error: "stripe is down for this customer" },
    ]);

    const rows = await rowsFor([billed, unbilledA, unbilledB]);
    expect(rows.get(billed)!.reportedAt).toBeNull(); // left for the next run
    expect(rows.get(unbilledA)!.reportedAt).not.toBeNull();
    expect(rows.get(unbilledB)!.reportedAt).not.toBeNull();

    // And the next run picks up exactly the stranded org.
    const retry = await run();
    expect(retry).toMatchObject({ reported: 1, organizations: 1, failures: [] });
    expect((await rowsFor([billed])).get(billed)!.reportedAt).not.toBeNull();
  });

  it("reports nothing when the only records are still inside the window", async () => {
    await seed(billedOrg, ago(5 * 60_000));
    expect(await run()).toMatchObject({ reported: 0, organizations: 0, failures: [] });
  });
});

describe("job dispatch", () => {
  it("the billing.report_usage handler is wired to the reporter", async () => {
    // Guards the one line in services/jobs.ts that the tests above bypass.
    // Deliberately calls the handler rather than processDueJobs: the two
    // integration suites run in parallel, and claiming from the shared queue
    // would race @corridor/db's SKIP LOCKED tests.
    const { jobHandlers } = await import("./services/jobs");
    const id = await seed(billedOrg, ago(3 * HOUR));
    const [job] = await withServiceRole(db, (tx) =>
      tx
        .insert(schema.backgroundJobs)
        .values({ organizationId: null, jobType: "billing.report_usage" })
        .returning(),
    );
    try {
      const result = await withServiceRole(db, (tx) =>
        jobHandlers["billing.report_usage"](tx, job!),
      );
      expect(result).toMatchObject({ failures: [] });
      expect((result as { reported: number }).reported).toBeGreaterThanOrEqual(1);
      expect((await rowsFor([id])).get(id)!.reportedAt).not.toBeNull();
    } finally {
      await withServiceRole(db, (tx) =>
        tx.delete(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, job!.id)),
      );
    }
  });
});
