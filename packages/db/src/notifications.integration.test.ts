/**
 * Phase 5 integration tests: notify_organization() fan-out + RLS on
 * notifications/notification_rules. Requires local Supabase + `pnpm db:seed`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls, withServiceRole } from "./rls";
import { notificationRules, notifications, organizationMembers } from "./schema";

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
  [ownerA, dispatcherA, readOnlyA, ownerB] = await Promise.all([
    actorFor("owner@pathfinder.demo"),
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
    const m: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = e.cause) m.push(e.message);
    return m.join(" | ");
  }
  throw new Error("expected rejection");
}

describe("notify_organization", () => {
  it("notifies every active member holding the required permission, and only them", async () => {
    const title = `Test alert ${crypto.randomUUID()}`;
    const rows = await withServiceRole(db, (tx) =>
      tx.execute<{ notification_id: string; user_id: string; email: string; channel: string[] }>(
        sql`select * from public.notify_organization(${ownerA.orgId}::uuid, 'alert.critical', 'alert.manage', ${title}, 'body', '/alerts')`,
      ),
    );
    const recipients = new Set(rows.map((r) => r.user_id));
    // owner, dispatcher and compliance officer hold alert.manage; read-only (grants: *.read only) does not.
    expect(recipients.has(ownerA.userId)).toBe(true);
    expect(recipients.has(dispatcherA.userId)).toBe(true);
    expect(recipients.has(readOnlyA.userId)).toBe(false);
    expect(rows.every((r) => r.email.includes("@"))).toBe(true);

    const stored = await withRls(db, as(ownerA), (tx) =>
      tx.select().from(notifications).where(eq(notifications.title, title)),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ linkPath: "/alerts", readAt: null });
  });

  it("respects a per-user opt-out (enabled=false) and does not notify that user", async () => {
    await withServiceRole(db, (tx) =>
      tx
        .insert(notificationRules)
        .values({
          organizationId: ownerA.orgId,
          userId: ownerA.userId,
          eventType: "alert.critical",
          enabled: false,
        })
        .onConflictDoUpdate({
          target: [
            notificationRules.organizationId,
            notificationRules.userId,
            notificationRules.eventType,
          ],
          set: { enabled: false },
        }),
    );
    const title = `Opt-out test ${crypto.randomUUID()}`;
    const rows = await withServiceRole(db, (tx) =>
      tx.execute<{ user_id: string }>(
        sql`select * from public.notify_organization(${ownerA.orgId}::uuid, 'alert.critical', 'alert.manage', ${title}, null, null)`,
      ),
    );
    expect(rows.some((r) => r.user_id === ownerA.userId)).toBe(false);
    await withServiceRole(db, (tx) =>
      tx
        .delete(notificationRules)
        .where(
          and(
            eq(notificationRules.organizationId, ownerA.orgId),
            eq(notificationRules.userId, ownerA.userId),
            eq(notificationRules.eventType, "alert.critical"),
          ),
        ),
    );
  });

  it("does not leak notifications to the wrong org (RLS scopes strictly to user, but sanity-check org isolation)", async () => {
    const title = `Org B only ${crypto.randomUUID()}`;
    await withServiceRole(db, (tx) =>
      tx.execute(
        sql`select public.notify_organization(${ownerB.orgId}::uuid, 'alert.critical', 'alert.manage', ${title}, null, null)`,
      ),
    );
    const seenByA = await withRls(db, as(ownerA), (tx) =>
      tx.select().from(notifications).where(eq(notifications.title, title)),
    );
    expect(seenByA).toHaveLength(0);
  });
});

describe("notifications RLS", () => {
  it("a user can only ever see and mark read their own notifications", async () => {
    const title = `Own-only test ${crypto.randomUUID()}`;
    await withServiceRole(db, (tx) =>
      tx.execute(
        sql`select public.notify_organization(${ownerA.orgId}::uuid, 'alert.critical', 'alert.manage', ${title}, null, null)`,
      ),
    );
    const [own] = await withRls(db, as(ownerA), (tx) =>
      tx.select().from(notifications).where(eq(notifications.title, title)),
    );
    expect(own).toBeDefined();

    // read-only holds no permission this event type requires, so it never received a row.
    const seenByReadOnly = await withRls(db, as(readOnlyA), (tx) =>
      tx.select().from(notifications).where(eq(notifications.title, title)),
    );
    expect(seenByReadOnly).toHaveLength(0);

    // dispatcher DID receive their own copy of this notification (also holds alert.manage) —
    // the RLS guarantee under test is that they can't touch OWNER's row, not that they lack one.
    // The UPDATE's USING clause excludes rows owned by other users, so it silently
    // matches zero rows rather than throwing.
    const attempted = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(eq(notifications.id, own!.id))
        .returning(),
    );
    expect(attempted).toHaveLength(0);
    const stillUnread = await withServiceRole(db, (tx) =>
      tx
        .select({ readAt: notifications.readAt })
        .from(notifications)
        .where(eq(notifications.id, own!.id)),
    );
    expect(stillUnread[0]?.readAt).toBeNull();

    const marked = await withRls(db, as(ownerA), (tx) =>
      tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(eq(notifications.id, own!.id))
        .returning({ id: notifications.id }),
    );
    expect(marked).toHaveLength(1);
  });

  it("cannot insert a notification directly (must go through notify_organization)", async () => {
    const msg = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .insert(notifications)
          .values({
            organizationId: ownerA.orgId,
            userId: ownerA.userId,
            eventType: "alert.critical",
            title: "direct insert",
          })
          .returning(),
      ),
    );
    expect(msg).toMatch(/permission denied|row-level security/i);
  });
});

describe("notification_rules RLS", () => {
  it("a user can manage only their own rules", async () => {
    const [row] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(notificationRules)
        .values({
          organizationId: dispatcherA.orgId,
          userId: dispatcherA.userId,
          eventType: "customs.decision",
          enabled: false,
          channel: ["in_app"],
        })
        .returning(),
    );
    expect(row?.userId).toBe(dispatcherA.userId);
    const denied = await rejection(
      withRls(db, as(readOnlyA), (tx) =>
        tx
          .insert(notificationRules)
          .values({
            organizationId: dispatcherA.orgId,
            userId: dispatcherA.userId,
            eventType: "customs.decision",
          })
          .returning(),
      ),
    );
    expect(denied).toMatch(/row-level security/);
    await withServiceRole(db, (tx) =>
      tx.delete(notificationRules).where(eq(notificationRules.id, row!.id)),
    );
  });
});
