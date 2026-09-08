/**
 * Customs gateway tables — migration 0023.
 *
 *   * customs_submissions is tenant data: readable with movement.read,
 *     written only with movement.transmit_to_customs, invisible across tenants;
 *   * carrier_notices is a shared catalogue, read-only from a session;
 *   * background_jobs_insert lets a transmitter enqueue customs.poll_status and
 *     nobody enqueue customs.notices_sync from a session.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/db test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls } from "./rls";
import {
  backgroundJobs,
  carrierNotices,
  customsSubmissions,
  movements,
  organizationMembers,
} from "./schema";

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
let dispatcherA: Actor;
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
  [dispatcherA, readOnlyA, ownerB] = await Promise.all([
    actorFor("dispatch@pathfinder.demo"),
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

async function createDraft(actor: Actor) {
  return withRls(db, as(actor), async (tx) => {
    const numRows = await tx.execute<{ n: string }>(
      sql`select public.next_movement_number(${actor.orgId}::uuid, 'ACE') as n`,
    );
    const [m] = await tx
      .insert(movements)
      .values({
        organizationId: actor.orgId,
        regime: "ACE",
        movementNumber: numRows[0]!.n,
        createdBy: actor.userId,
      })
      .returning();
    return m!;
  });
}

describe("customs_submissions", () => {
  it("a transmitter records a filing; a reader sees it; the other tenant never does", async () => {
    const m = await createDraft(dispatcherA);
    try {
      const [sub] = await withRls(db, as(dispatcherA), (tx) =>
        tx
          .insert(customsSubmissions)
          .values({
            organizationId: dispatcherA.orgId,
            movementId: m.id,
            kind: "original",
            provider: "cbp_ace",
            mode: "gateway",
            referenceNumber: `ACE-TEST-${Date.now()}`,
            status: "acknowledged",
          })
          .returning(),
      );
      expect(sub?.status).toBe("acknowledged");

      const seenByReader = await withRls(db, as(readOnlyA), (tx) =>
        tx.select().from(customsSubmissions).where(eq(customsSubmissions.id, sub!.id)),
      );
      expect(seenByReader).toHaveLength(1);
      const readerWrite = await withRls(db, as(readOnlyA), (tx) =>
        tx
          .update(customsSubmissions)
          .set({ status: "released" })
          .where(eq(customsSubmissions.id, sub!.id))
          .returning(),
      );
      expect(readerWrite).toHaveLength(0);

      const seenByB = await withRls(db, as(ownerB), (tx) =>
        tx.select().from(customsSubmissions).where(eq(customsSubmissions.id, sub!.id)),
      );
      expect(seenByB).toHaveLength(0);
      const all = await withRls(db, as(ownerB), (tx) => tx.select().from(customsSubmissions));
      expect(all.every((r) => r.organizationId === ownerB.orgId)).toBe(true);

      const deleted = await withRls(db, as(dispatcherA), (tx) =>
        tx.delete(customsSubmissions).where(eq(customsSubmissions.id, sub!.id)).returning(),
      );
      expect(deleted).toHaveLength(0);
    } finally {
      await db.delete(movements).where(eq(movements.id, m.id));
    }
  });

  it("read-only cannot record a filing even in their own org", async () => {
    const m = await createDraft(dispatcherA);
    try {
      const msg = await rejection(
        withRls(db, as(readOnlyA), (tx) =>
          tx
            .insert(customsSubmissions)
            .values({
              organizationId: readOnlyA.orgId,
              movementId: m.id,
              kind: "original",
              provider: "cbp_ace",
              mode: "mock",
            })
            .returning(),
        ),
      );
      expect(msg).toMatch(/row-level security/);
    } finally {
      await db.delete(movements).where(eq(movements.id, m.id));
    }
  });
});

describe("carrier_notices", () => {
  it("is readable by every organization and read-only from a session", async () => {
    const externalId = `test-notice-${Date.now()}`;
    await db.insert(carrierNotices).values({
      provider: "cbp_ace",
      externalId,
      severity: "warning",
      title: "Test notice",
    });
    try {
      const [fromA, fromB] = await Promise.all([
        withRls(db, as(readOnlyA), (tx) =>
          tx.select().from(carrierNotices).where(eq(carrierNotices.externalId, externalId)),
        ),
        withRls(db, as(ownerB), (tx) =>
          tx.select().from(carrierNotices).where(eq(carrierNotices.externalId, externalId)),
        ),
      ]);
      expect(fromA).toHaveLength(1);
      expect(fromB).toHaveLength(1);
      await expect(
        withRls(db, as(dispatcherA), (tx) =>
          tx
            .insert(carrierNotices)
            .values({ provider: "cbp_ace", externalId: `${externalId}-x`, title: "Nope" }),
        ),
      ).rejects.toThrow();
    } finally {
      await db.delete(carrierNotices).where(eq(carrierNotices.externalId, externalId));
    }
  });
});

describe("background_jobs_insert after 0023", () => {
  it("a transmitter may enqueue customs.poll_status; nobody enqueues customs.notices_sync", async () => {
    const [job] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(backgroundJobs)
        .values({
          organizationId: dispatcherA.orgId,
          jobType: "customs.poll_status",
          payload: { movementId: "00000000-0000-4000-8000-000000000000" },
          runAt: new Date(Date.now() + 3_600_000),
        })
        .returning({ id: backgroundJobs.id }),
    );
    expect(job?.id).toBeTypeOf("number");
    await db.delete(backgroundJobs).where(eq(backgroundJobs.id, job!.id));

    const msg = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx
          .insert(backgroundJobs)
          .values({ organizationId: dispatcherA.orgId, jobType: "customs.notices_sync", payload: {} })
          .returning(),
      ),
    );
    expect(msg).toMatch(/row-level security/);
    const reader = await rejection(
      withRls(db, as(readOnlyA), (tx) =>
        tx
          .insert(backgroundJobs)
          .values({ organizationId: readOnlyA.orgId, jobType: "customs.poll_status", payload: {} })
          .returning(),
      ),
    );
    expect(reader).toMatch(/row-level security/);
  });
});
