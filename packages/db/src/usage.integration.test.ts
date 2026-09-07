/**
 * Usage metering (migration 0013): record_usage() is the only write path open
 * to a session, it refuses to meter an organization the caller is not in, and
 * usage_records is readable only by a member with `billing.read`.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/db test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls, withServiceRole } from "./rls";
import { organizationMembers, usageRecords } from "./schema";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const conn = createDb(DB_URL, { max: 2 });
const db = conn.db;

interface Actor {
  userId: string;
  email: string;
  orgId: string;
}

let ownerA: Actor;
let readOnlyA: Actor;
let dispatchA: Actor;
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
  if (!m) throw new Error(`no membership for ${email}`);
  return { userId: user.id, email, orgId: m.orgId };
}

beforeAll(async () => {
  [ownerA, readOnlyA, dispatchA, ownerB] = await Promise.all([
    actorFor("owner@pathfinder.demo"),
    actorFor("readonly@pathfinder.demo"),
    actorFor("dispatch@pathfinder.demo"),
    actorFor("owner@northbound.demo"),
  ]);
  expect(ownerA.orgId).not.toBe(ownerB.orgId);
});

afterAll(async () => {
  await withServiceRole(db, (tx) =>
    tx.delete(usageRecords).where(sql`${usageRecords.metadata} ->> 'test' is not null`),
  );
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

/** record_usage(org, metric, qty, metadata) as `actor`, returning the new id. */
async function recordAs(actor: Actor, orgId: string, metric: string, tag: string, qty = 1) {
  const rows = await withRls(db, as(actor), (tx) =>
    tx.execute<{ record_usage: string }>(sql`
      select public.record_usage(
        ${orgId}::uuid, ${metric}, ${qty}::int, ${JSON.stringify({ test: tag })}::jsonb
      )
    `),
  );
  return Number(rows[0]!.record_usage);
}

describe("record_usage", () => {
  it("an org member meters their own organization", async () => {
    const id = await recordAs(ownerA, ownerA.orgId, "documents_extracted", "own-org", 3);
    expect(id).toBeGreaterThan(0);
    const [row] = await withServiceRole(db, (tx) =>
      tx.select().from(usageRecords).where(eq(usageRecords.id, id)),
    );
    expect(row).toMatchObject({
      organizationId: ownerA.orgId,
      metric: "documents_extracted",
      quantity: 3,
      reportedAt: null,
      stripeMeterEventId: null,
    });
  });

  it("stamps period_start as the first day of occurred_at's UTC month", async () => {
    const id = await recordAs(ownerA, ownerA.orgId, "copilot_messages", "period");
    const [row] = await withServiceRole(db, (tx) =>
      tx
        .select({ periodStart: usageRecords.periodStart, occurredAt: usageRecords.occurredAt })
        .from(usageRecords)
        .where(eq(usageRecords.id, id)),
    );
    const occurred = row!.occurredAt;
    const expected = `${occurred.getUTCFullYear()}-${String(occurred.getUTCMonth() + 1).padStart(2, "0")}-01`;
    expect(row!.periodStart).toBe(expected);
  });

  it("the service-role worker can meter without a session", async () => {
    // The document-extraction job runs under the service role, in a transaction
    // with no request.jwt.claims — record_usage() must still write.
    const rows = await withServiceRole(db, (tx) =>
      tx.execute<{ record_usage: string }>(sql`
        select public.record_usage(
          ${ownerB.orgId}::uuid, 'documents_extracted', 1::int,
          ${JSON.stringify({ test: "worker" })}::jsonb
        )
      `),
    );
    const id = Number(rows[0]!.record_usage);
    const [row] = await withServiceRole(db, (tx) =>
      tx.select().from(usageRecords).where(eq(usageRecords.id, id)),
    );
    expect(row).toMatchObject({ organizationId: ownerB.orgId, metric: "documents_extracted" });
  });

  it("refuses to meter an organization the caller is not a member of", async () => {
    const msg = await rejection(recordAs(ownerA, ownerB.orgId, "documents_extracted", "cross"));
    expect(msg).toMatch(/not a member of organization/i);
  });

  it("rejects a metric outside the supported set", async () => {
    const msg = await rejection(recordAs(ownerA, ownerA.orgId, "bitcoin_mined", "bad-metric"));
    expect(msg).toMatch(/usage_records_metric_check|violates check constraint/i);
  });

  it("is the only write path: a session cannot insert, update or delete directly", async () => {
    const insert = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .insert(usageRecords)
          .values({
            organizationId: ownerA.orgId,
            metric: "documents_extracted",
            quantity: 9999,
            periodStart: "2026-01-01",
            metadata: { test: "forged" },
          })
          .returning(),
      ),
    );
    expect(insert).toMatch(/permission denied/i);

    const id = await recordAs(ownerA, ownerA.orgId, "documents_extracted", "immutable");
    const update = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx.update(usageRecords).set({ quantity: 0 }).where(eq(usageRecords.id, id)).returning(),
      ),
    );
    expect(update).toMatch(/permission denied/i);

    const remove = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx.delete(usageRecords).where(eq(usageRecords.id, id)).returning(),
      ),
    );
    expect(remove).toMatch(/permission denied/i);
  });
});

describe("usage_records RLS", () => {
  it("cross-tenant: Org B cannot read a record Org A metered", async () => {
    const id = await recordAs(ownerA, ownerA.orgId, "movements_transmitted", "cross-read");
    const mine = await withRls(db, as(ownerA), (tx) =>
      tx.select().from(usageRecords).where(eq(usageRecords.id, id)),
    );
    expect(mine).toHaveLength(1);

    const theirs = await withRls(db, as(ownerB), (tx) =>
      tx.select().from(usageRecords).where(eq(usageRecords.id, id)),
    );
    expect(theirs).toHaveLength(0);

    const everything = await withRls(db, as(ownerB), (tx) => tx.select().from(usageRecords));
    expect(everything.every((r) => r.organizationId === ownerB.orgId)).toBe(true);
  });

  it("a member with billing.read but not billing.manage still sees the meter", async () => {
    // Read-Only holds every *.read key, Admin holds billing.read without
    // billing.manage — both must see the usage the billing page shows them.
    const id = await recordAs(ownerA, ownerA.orgId, "ai_suggestions", "permission");
    const seen = await withRls(db, as(readOnlyA), (tx) =>
      tx
        .select()
        .from(usageRecords)
        .where(and(eq(usageRecords.id, id), eq(usageRecords.organizationId, readOnlyA.orgId))),
    );
    expect(seen).toHaveLength(1);
  });

  it("a member without billing.read sees nothing, even in their own org", async () => {
    // Dispatcher has no billing permission at all.
    const id = await recordAs(ownerA, ownerA.orgId, "ai_suggestions", "no-billing-read");
    const seen = await withRls(db, as(dispatchA), (tx) =>
      tx
        .select()
        .from(usageRecords)
        .where(and(eq(usageRecords.id, id), eq(usageRecords.organizationId, dispatchA.orgId))),
    );
    expect(seen).toHaveLength(0);
  });
});
