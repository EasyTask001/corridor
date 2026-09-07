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
    // three workers race for 5 each
    const claims = await Promise.all(
      ["w1", "w2", "w3"].map((w) =>
        withServiceRole(db, (tx) =>
          tx.execute<{ id: number; locked_by: string }>(
            sql`select id, locked_by from public.claim_jobs(5, ${w})`,
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
});
