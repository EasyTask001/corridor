/**
 * Phase 3 integration tests: job queue claiming (SKIP LOCKED, no double
 * claims across concurrent workers), and RLS on integration tables.
 * Requires local Supabase + `pnpm db:seed`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq, inArray, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls, withServiceRole } from "./rls";
import {
  backgroundJobs,
  integrationConfigs,
  integrationEvents,
  organizationMembers,
  organizations,
  subscriptions,
} from "./schema";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const conn = createDb(DB_URL, { max: 4 });
const db = conn.db;

interface Actor {
  userId: string;
  email: string;
  orgId: string;
}
let ownerA: Actor;
let readOnlyA: Actor;
let ownerB: Actor;

async function actorFor(email: string): Promise<Actor> {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY required");
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const user = data?.users.find((u) => u.email === email);
  if (!user) throw new Error(`seed user ${email} missing — run pnpm db:seed`);
  const [m] = await db
    .select({ orgId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, user.id))
    .limit(1);
  return { userId: user.id, email, orgId: m!.orgId };
}

beforeAll(async () => {
  [ownerA, readOnlyA, ownerB] = await Promise.all([
    actorFor("owner@pathfinder.demo"),
    actorFor("readonly@pathfinder.demo"),
    actorFor("owner@northbound.demo"),
  ]);
});

afterAll(async () => {
  await conn.sql.end();
});

const as = (a: Actor) => ({ sub: a.userId, email: a.email });

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const messages: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = e.cause) messages.push(e.message);
    return messages.join(" | ");
  }
  throw new Error("expected rejection");
}

describe("background_jobs queue", () => {
  it("claim_jobs hands each due job to exactly one of several concurrent workers", async () => {
    const tag = `test-${Date.now()}`;
    const ids = await withServiceRole(db, (tx) =>
      tx
        .insert(backgroundJobs)
        .values(
          Array.from({ length: 12 }, (_, i) => ({
            organizationId: ownerA.orgId,
            jobType: "noop.test",
            payload: { tag, i },
            runAt: new Date(Date.now() - 1000),
          })),
        )
        .returning({ id: backgroundJobs.id }),
    );
    // three workers race for 5 each. The per-org cap is raised out of the way
    // here — this test is about SKIP LOCKED, not the cap (covered separately).
    const claims = await Promise.all(
      ["w1", "w2", "w3"].map((w) =>
        withServiceRole(db, (tx) =>
          tx.execute<{ id: number; locked_by: string }>(
            sql`select id, locked_by from public.claim_jobs(5, ${w}, 1000)`,
          ),
        ),
      ),
    );
    const all = claims.flat().map((r) => Number(r.id));
    const mine = all.filter((id) => ids.some((x) => x.id === id));
    expect(new Set(mine).size).toBe(mine.length); // no duplicates
    expect(mine.length).toBe(12); // 5+5+2, everything claimed exactly once
    const rows = await withServiceRole(db, (tx) =>
      tx
        .select({ status: backgroundJobs.status, attempts: backgroundJobs.attempts })
        .from(backgroundJobs)
        .where(
          inArray(
            backgroundJobs.id,
            ids.map((x) => x.id),
          ),
        ),
    );
    expect(rows.every((r) => r.status === "running" && r.attempts === 1)).toBe(true);
    // cleanup
    await withServiceRole(db, (tx) =>
      tx.delete(backgroundJobs).where(
        inArray(
          backgroundJobs.id,
          ids.map((x) => x.id),
        ),
      ),
    );
  });

  it("future jobs are not claimable yet", async () => {
    const [j] = await withServiceRole(db, (tx) =>
      tx
        .insert(backgroundJobs)
        .values({
          organizationId: ownerA.orgId,
          jobType: "noop.test",
          runAt: new Date(Date.now() + 60_000),
        })
        .returning({ id: backgroundJobs.id }),
    );
    const claimed = await withServiceRole(db, (tx) =>
      tx.execute<{ id: number }>(sql`select id from public.claim_jobs(100, 'w')`),
    );
    expect(claimed.map((r) => Number(r.id))).not.toContain(j!.id);
    await withServiceRole(db, (tx) =>
      tx.delete(backgroundJobs).where(eq(backgroundJobs.id, j!.id)),
    );
  });

  it("authenticated users may enqueue authorized jobs but cannot arbitrary, cross-org, or claim", async () => {
    const [j] = await withRls(db, as(ownerA), (tx) =>
      tx
        .insert(backgroundJobs)
        .values({
          organizationId: ownerA.orgId,
          jobType: "compliance.scan",
          runAt: new Date(Date.now() + 3600_000),
        })
        .returning({ id: backgroundJobs.id }),
    );
    expect(j?.id).toBeTruthy();
    const msg = await rejection(
      withRls(db, as(ownerA), (tx) => tx.execute(sql`select * from public.claim_jobs(1, 'x')`)),
    );
    expect(msg).toMatch(/permission denied/i);
    const arbitrary = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .insert(backgroundJobs)
          .values({ organizationId: ownerA.orgId, jobType: "noop.test" })
          .returning(),
      ),
    );
    expect(arbitrary).toMatch(/row-level security/);
    const cross = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .insert(backgroundJobs)
          .values({ organizationId: ownerB.orgId, jobType: "compliance.scan" })
          .returning(),
      ),
    );
    expect(cross).toMatch(/row-level security/);
    await withServiceRole(db, (tx) =>
      tx.delete(backgroundJobs).where(eq(backgroundJobs.id, j!.id)),
    );
  });

  it("caps how many jobs one organization may have running at once", async () => {
    // Throwaway orgs so the global 'running' counts of the seeded orgs can't
    // interfere with the cap arithmetic.
    const [orgA, orgB] = await db
      .insert(organizations)
      .values([{ name: `Job Cap A ${Date.now()}` }, { name: `Job Cap B ${Date.now()}` }])
      .returning({ id: organizations.id });

    // Well in the past so these sort ahead of anything else that may be due.
    const runAt = new Date(Date.now() - 2 * 3600_000);
    const claim = (worker: string) =>
      withServiceRole(db, (tx) =>
        tx.execute<{ id: number; organization_id: string }>(
          sql`select id, organization_id from public.claim_jobs(10, ${worker})`,
        ),
      );
    const forOrg = <T extends { organization_id: string }>(rows: T[], orgId: string) =>
      rows.filter((r) => r.organization_id === orgId);

    try {
      await withServiceRole(db, (tx) =>
        tx.insert(backgroundJobs).values([
          { organizationId: orgA!.id, jobType: "noop.test", runAt },
          { organizationId: orgA!.id, jobType: "noop.test", runAt },
          { organizationId: orgA!.id, jobType: "noop.test", runAt },
          { organizationId: orgB!.id, jobType: "noop.test", runAt },
        ]),
      );

      // Default cap is 2: Org A's third job waits, Org B is unaffected by it.
      const first = await claim("cap-w1");
      expect(forOrg(first, orgA!.id)).toHaveLength(2);
      expect(forOrg(first, orgB!.id)).toHaveLength(1);

      // Org A is at its cap, so the third job stays pending.
      const second = await claim("cap-w2");
      expect(forOrg(second, orgA!.id)).toHaveLength(0);

      // Finishing one frees a slot.
      await withServiceRole(db, (tx) =>
        tx
          .update(backgroundJobs)
          .set({ status: "succeeded", finishedAt: new Date() })
          .where(eq(backgroundJobs.id, Number(forOrg(first, orgA!.id)[0]!.id))),
      );
      const third = await claim("cap-w3");
      expect(forOrg(third, orgA!.id)).toHaveLength(1);

      // An explicit higher cap is honoured (nothing is left pending here, but a
      // cap of 0 must claim nothing even when jobs are due).
      await withServiceRole(db, (tx) =>
        tx.insert(backgroundJobs).values({ organizationId: orgA!.id, jobType: "noop.test", runAt }),
      );
      const capped = await withServiceRole(db, (tx) =>
        tx.execute<{ id: number; organization_id: string }>(
          sql`select id, organization_id from public.claim_jobs(10, 'cap-w4', 1)`,
        ),
      );
      expect(forOrg(capped, orgA!.id)).toHaveLength(0);
    } finally {
      // cascades to the jobs
      await db.delete(organizations).where(inArray(organizations.id, [orgA!.id, orgB!.id]));
    }
  });

  it("never caps jobs with no organization (internal/system work)", async () => {
    const runAt = new Date(Date.now() - 2 * 3600_000);
    const ids = await withServiceRole(db, (tx) =>
      tx
        .insert(backgroundJobs)
        .values(
          Array.from({ length: 4 }, () => ({
            organizationId: null,
            jobType: "noop.test",
            runAt,
          })),
        )
        .returning({ id: backgroundJobs.id }),
    );
    try {
      const claimed = await withServiceRole(db, (tx) =>
        tx.execute<{ id: number }>(sql`select id from public.claim_jobs(10, 'sys-w', 2)`),
      );
      const mine = claimed.map((r) => Number(r.id)).filter((id) => ids.some((x) => x.id === id));
      expect(mine).toHaveLength(4);
    } finally {
      await withServiceRole(db, (tx) =>
        tx.delete(backgroundJobs).where(
          inArray(
            backgroundJobs.id,
            ids.map((x) => x.id),
          ),
        ),
      );
    }
  });

  it("reclaims a job whose worker died, but not one still inside its lease", async () => {
    // Own org so the per-org cap arithmetic cannot be perturbed by seeded jobs.
    const [org] = await db
      .insert(organizations)
      .values({ name: `Job Lease ${Date.now()}` })
      .returning({ id: organizations.id });
    try {
      const [stale, fresh] = await withServiceRole(db, (tx) =>
        tx
          .insert(backgroundJobs)
          .values([
            // Claimed 20 minutes ago and never finished — its worker is gone.
            {
              organizationId: org!.id,
              jobType: "noop.test",
              status: "running" as const,
              attempts: 1,
              lockedBy: "dead-worker",
              lockedAt: new Date(Date.now() - 20 * 60_000),
              startedAt: new Date(Date.now() - 20 * 60_000),
            },
            // Claimed a minute ago — still working.
            {
              organizationId: org!.id,
              jobType: "noop.test",
              status: "running" as const,
              attempts: 1,
              lockedBy: "live-worker",
              lockedAt: new Date(Date.now() - 60_000),
              startedAt: new Date(Date.now() - 60_000),
            },
          ])
          .returning({ id: backgroundJobs.id }),
      );

      // 600s lease: the 20-minute-old claim is expired, the 1-minute-old is not.
      const claimed = await withServiceRole(db, (tx) =>
        tx.execute<{ id: number; locked_by: string; attempts: number }>(
          sql`select id, locked_by, attempts from public.claim_jobs(10, 'reaper', 5, 600)`,
        ),
      );
      const ids = claimed.map((r) => Number(r.id));
      expect(ids).toContain(stale!.id);
      expect(ids).not.toContain(fresh!.id);

      const rows = await withServiceRole(db, (tx) =>
        tx
          .select({
            id: backgroundJobs.id,
            status: backgroundJobs.status,
            attempts: backgroundJobs.attempts,
            lockedBy: backgroundJobs.lockedBy,
          })
          .from(backgroundJobs)
          .where(inArray(backgroundJobs.id, [stale!.id, fresh!.id])),
      );
      const reclaimed = rows.find((r) => r.id === stale!.id)!;
      const untouched = rows.find((r) => r.id === fresh!.id)!;
      // Reclaimed like any other claim: re-locked, attempts incremented.
      expect(reclaimed).toMatchObject({ status: "running", attempts: 2, lockedBy: "reaper" });
      // Still held by the worker that is presumed alive.
      expect(untouched).toMatchObject({ status: "running", attempts: 1, lockedBy: "live-worker" });
    } finally {
      await db.delete(organizations).where(eq(organizations.id, org!.id));
    }
  });

  it("stops reclaiming once a stale job has used up max_attempts", async () => {
    const [org] = await db
      .insert(organizations)
      .values({ name: `Job Lease Max ${Date.now()}` })
      .returning({ id: organizations.id });
    try {
      const [exhausted] = await withServiceRole(db, (tx) =>
        tx
          .insert(backgroundJobs)
          .values({
            organizationId: org!.id,
            jobType: "noop.test",
            status: "running" as const,
            attempts: 3,
            maxAttempts: 3,
            lockedBy: "dead-worker",
            lockedAt: new Date(Date.now() - 60 * 60_000),
          })
          .returning({ id: backgroundJobs.id }),
      );
      const claimed = await withServiceRole(db, (tx) =>
        tx.execute<{ id: number }>(sql`select id from public.claim_jobs(10, 'reaper2', 5, 600)`),
      );
      expect(claimed.map((r) => Number(r.id))).not.toContain(exhausted!.id);
    } finally {
      await db.delete(organizations).where(eq(organizations.id, org!.id));
    }
  });

  it("a stale job does not consume one of its organization's cap slots", async () => {
    const [org] = await db
      .insert(organizations)
      .values({ name: `Job Lease Cap ${Date.now()}` })
      .returning({ id: organizations.id });
    try {
      const runAt = new Date(Date.now() - 2 * 3600_000);
      await withServiceRole(db, (tx) =>
        tx.insert(backgroundJobs).values([
          {
            organizationId: org!.id,
            jobType: "noop.test",
            status: "running" as const,
            attempts: 1,
            maxAttempts: 5,
            lockedBy: "dead-worker",
            lockedAt: new Date(Date.now() - 30 * 60_000),
          },
          { organizationId: org!.id, jobType: "noop.test", runAt },
          { organizationId: org!.id, jobType: "noop.test", runAt },
        ]),
      );
      // Cap of 2. Were the dead worker's job still counted as running, only one
      // pending job could be claimed; with the reclaim it is 2 (the stale one
      // plus the older pending one).
      const claimed = await withServiceRole(db, (tx) =>
        tx.execute<{ id: number; organization_id: string }>(
          sql`select id, organization_id from public.claim_jobs(10, 'cap-lease', 2, 600)`,
        ),
      );
      expect(claimed.filter((r) => r.organization_id === org!.id)).toHaveLength(2);
    } finally {
      await db.delete(organizations).where(eq(organizations.id, org!.id));
    }
  });
});

describe("integration tables RLS", () => {
  it("integration_configs visible only with integrations.manage, and only own org", async () => {
    const a = await withRls(db, as(ownerA), (tx) => tx.select().from(integrationConfigs));
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((c) => c.organizationId === ownerA.orgId)).toBe(true);
    const ro = await withRls(db, as(readOnlyA), (tx) => tx.select().from(integrationConfigs));
    expect(ro).toHaveLength(0);
    const b = await withRls(db, as(ownerB), (tx) =>
      tx
        .select()
        .from(integrationConfigs)
        .where(eq(integrationConfigs.organizationId, ownerA.orgId)),
    );
    expect(b).toHaveLength(0);
  });

  it("integration_events are append-only for authenticated users", async () => {
    const [ev] = await withRls(db, as(ownerA), (tx) =>
      tx
        .insert(integrationEvents)
        .values({
          organizationId: ownerA.orgId,
          provider: "test",
          direction: "outbound",
          operation: "t",
          success: true,
        })
        .returning({ id: integrationEvents.id }),
    );
    const msg = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .update(integrationEvents)
          .set({ success: false })
          .where(eq(integrationEvents.id, ev!.id)),
      ),
    );
    expect(msg).toMatch(/permission denied/i);
    await withServiceRole(db, (tx) =>
      tx.delete(integrationEvents).where(eq(integrationEvents.id, ev!.id)),
    );
  });

  it("subscriptions are read-only to users and sync the organization plan", async () => {
    const denied = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .insert(subscriptions)
          .values({ organizationId: ownerA.orgId, plan: "enterprise", status: "active" })
          .returning(),
      ),
    );
    expect(denied).toMatch(/permission denied/i);
    await withServiceRole(db, (tx) =>
      tx
        .insert(subscriptions)
        .values({ organizationId: ownerB.orgId, plan: "professional", status: "active", seats: 10 })
        .onConflictDoUpdate({
          target: subscriptions.organizationId,
          set: { plan: "professional", status: "active" },
        }),
    );
    const [org] = await withServiceRole(db, (tx) =>
      tx.execute<{ subscription_plan: string; subscription_status: string }>(
        sql`select subscription_plan, subscription_status from public.organizations where id = ${ownerB.orgId}`,
      ),
    );
    expect(org).toMatchObject({ subscription_plan: "professional", subscription_status: "active" });
    const visible = await withRls(db, as(readOnlyA), (tx) => tx.select().from(subscriptions));
    expect(visible.every((s) => s.organizationId === readOnlyA.orgId)).toBe(true);
  });

  it("cross-tenant: Org A sees zero Org B integration_events rows", async () => {
    const [ev] = await withServiceRole(db, (tx) =>
      tx
        .insert(integrationEvents)
        .values({
          organizationId: ownerB.orgId,
          provider: "test",
          direction: "outbound",
          operation: "cross-tenant-probe",
          success: true,
        })
        .returning({ id: integrationEvents.id }),
    );
    try {
      const seen = await withRls(db, as(ownerA), (tx) =>
        tx.select().from(integrationEvents).where(eq(integrationEvents.id, ev!.id)),
      );
      expect(seen).toHaveLength(0);
      const all = await withRls(db, as(ownerA), (tx) => tx.select().from(integrationEvents));
      expect(all.every((r) => r.organizationId === ownerA.orgId)).toBe(true);
    } finally {
      await withServiceRole(db, (tx) =>
        tx.delete(integrationEvents).where(eq(integrationEvents.id, ev!.id)),
      );
    }
  });

  it("cross-tenant: Org A sees zero Org B subscriptions rows", async () => {
    await withServiceRole(db, (tx) =>
      tx
        .insert(subscriptions)
        .values({ organizationId: ownerB.orgId, plan: "professional", status: "active" })
        .onConflictDoUpdate({
          target: subscriptions.organizationId,
          set: { plan: "professional", status: "active" },
        }),
    );
    const seen = await withRls(db, as(ownerA), (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.organizationId, ownerB.orgId)),
    );
    expect(seen).toHaveLength(0);
    const all = await withRls(db, as(ownerA), (tx) => tx.select().from(subscriptions));
    expect(all.every((r) => r.organizationId === ownerA.orgId)).toBe(true);
  });
});
