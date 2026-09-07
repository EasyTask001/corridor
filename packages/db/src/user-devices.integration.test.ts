/**
 * Task 11 integration tests: `user_devices` is user-scoped — a member sees and
 * writes only their own handsets — and `push_tokens_for()` (SECURITY DEFINER)
 * is the only path by which the notification fan-out reaches someone else's
 * token. Requires local Supabase + `pnpm db:seed`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls, withServiceRole } from "./rls";
import { organizationMembers, userDevices } from "./schema";

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
  [ownerA, dispatcherA, ownerB] = await Promise.all([
    actorFor("owner@pathfinder.demo"),
    actorFor("dispatch@pathfinder.demo"),
    actorFor("owner@northbound.demo"),
  ]);
});
afterEach(async () => {
  await withServiceRole(db, (tx) => tx.delete(userDevices));
});
afterAll(async () => {
  await conn.sql.end();
});

const as = (a: Actor) => ({ sub: a.userId, email: a.email });
const tokenFor = (label: string) => `ExponentPushToken[${label}-${crypto.randomUUID()}]`;

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

/** Register a device the way `notifications.registerDevice` does. */
function register(actor: Actor, token: string, platform: "ios" | "android" = "android") {
  return withRls(db, as(actor), (tx) =>
    tx
      .insert(userDevices)
      .values({
        userId: actor.userId,
        organizationId: actor.orgId,
        expoPushToken: token,
        platform,
      })
      .onConflictDoUpdate({
        target: [userDevices.userId, userDevices.expoPushToken],
        set: { organizationId: actor.orgId, platform, updatedAt: sql`now()` },
      })
      .returning({ id: userDevices.id }),
  );
}

describe("user_devices RLS", () => {
  it("lets a user register and read back their own device", async () => {
    const token = tokenFor("own");
    const [row] = await register(ownerA, token, "ios");
    expect(row?.id).toBeTruthy();

    const mine = await withRls(db, as(ownerA), (tx) => tx.select().from(userDevices));
    expect(mine.map((d) => d.expoPushToken)).toEqual([token]);
  });

  it("hides another member's devices, even inside the same org", async () => {
    await register(dispatcherA, tokenFor("dispatcher"));
    const seenByOwner = await withRls(db, as(ownerA), (tx) => tx.select().from(userDevices));
    expect(seenByOwner).toEqual([]);
    // ...and across orgs, for good measure.
    const seenByOtherOrg = await withRls(db, as(ownerB), (tx) => tx.select().from(userDevices));
    expect(seenByOtherOrg).toEqual([]);
  });

  it("refuses a row written on another user's behalf", async () => {
    const message = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx.insert(userDevices).values({
          userId: dispatcherA.userId,
          organizationId: ownerA.orgId,
          expoPushToken: tokenFor("spoof"),
          platform: "android",
        }),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it("refuses a device registered against an org the user does not belong to", async () => {
    const message = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx.insert(userDevices).values({
          userId: ownerA.userId,
          organizationId: ownerB.orgId,
          expoPushToken: tokenFor("wrong-org"),
          platform: "android",
        }),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it("cannot delete someone else's device", async () => {
    const token = tokenFor("keep");
    await register(dispatcherA, token);
    await withRls(db, as(ownerA), (tx) => tx.delete(userDevices));
    const still = await withRls(db, as(dispatcherA), (tx) => tx.select().from(userDevices));
    expect(still.map((d) => d.expoPushToken)).toEqual([token]);
  });

  it("re-registering the same token updates in place rather than duplicating", async () => {
    const token = tokenFor("stable");
    await register(ownerA, token, "android");
    await register(ownerA, token, "ios");
    const rows = await withRls(db, as(ownerA), (tx) => tx.select().from(userDevices));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.platform).toBe("ios");
  });
});

describe("push_tokens_for", () => {
  const sqlFor = (orgId: string, userIds: string[]) =>
    sql`select * from public.push_tokens_for(${orgId}::uuid, array[${sql.join(
      userIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}])`;

  /** The fan-out's real call path: a service-role transaction. */
  const asServiceRole = (orgId: string, userIds: string[]) =>
    withServiceRole(db, (tx) =>
      tx.execute<{ user_id: string; expo_push_token: string; platform: string }>(
        sqlFor(orgId, userIds),
      ),
    );

  /** What a member could attempt through PostgREST if the grant were wrong. */
  const asMember = (actor: Actor, orgId: string, userIds: string[]) =>
    withRls(db, as(actor), (tx) => tx.execute(sqlFor(orgId, userIds)));

  it("returns every device of the requested recipients in that org", async () => {
    const one = tokenFor("phone-1");
    const two = tokenFor("phone-2");
    await register(dispatcherA, one);
    await register(dispatcherA, two);

    const rows = await asServiceRole(ownerA.orgId, [dispatcherA.userId]);
    expect(rows.map((r) => r.expo_push_token).sort()).toEqual([one, two].sort());
  });

  it("never crosses an organization boundary", async () => {
    await register(dispatcherA, tokenFor("org-a"));
    // Asking org B for an org-A member's tokens yields nothing.
    expect(await asServiceRole(ownerB.orgId, [dispatcherA.userId])).toEqual([]);
  });

  it("skips members who are no longer active", async () => {
    await register(dispatcherA, tokenFor("suspended"));
    await withServiceRole(db, (tx) =>
      tx
        .update(organizationMembers)
        .set({ status: "suspended" })
        .where(eq(organizationMembers.userId, dispatcherA.userId)),
    );
    try {
      expect(await asServiceRole(ownerA.orgId, [dispatcherA.userId])).toEqual([]);
    } finally {
      await withServiceRole(db, (tx) =>
        tx
          .update(organizationMembers)
          .set({ status: "active" })
          .where(eq(organizationMembers.userId, dispatcherA.userId)),
      );
    }
  });

  // A push token is a bearer capability — whoever holds it can push to that
  // handset. EXECUTE is therefore revoked from `authenticated` (migration 0015),
  // so no member can reach it, in their own org or anyone else's.
  it("is not executable by a member of the same organization", async () => {
    await register(dispatcherA, tokenFor("same-org"));
    const message = await rejection(asMember(ownerA, ownerA.orgId, [dispatcherA.userId]));
    expect(message).toMatch(/permission denied for function push_tokens_for/i);
  });

  it("is not executable by a member of another organization", async () => {
    await register(dispatcherA, tokenFor("cross-org"));
    const message = await rejection(asMember(ownerB, ownerA.orgId, [dispatcherA.userId]));
    expect(message).toMatch(/permission denied for function push_tokens_for/i);
  });
});
