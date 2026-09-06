/**
 * Phase 2 integration tests: DB-level state machine parity with the domain
 * table, edit-lock triggers, append-only events, RLS on movements.
 * Requires local Supabase + `pnpm db:seed`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { MOVEMENT_TRANSITIONS, movementStatus } from "@corridor/domain";
import { createDb } from "./client";
import { withRls } from "./rls";
import { cargo, movementEvents, movements, organizationMembers } from "./schema";

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
    const n = numRows[0]!.n;
    const [m] = await tx
      .insert(movements)
      .values({
        organizationId: actor.orgId,
        regime: "ACE",
        movementNumber: n,
        createdBy: actor.userId,
      })
      .returning();
    return m!;
  });
}

describe("state machine parity (SQL vs domain)", () => {
  it("movement_can_transition agrees with MOVEMENT_TRANSITIONS for every pair", async () => {
    const statuses = movementStatus.options;
    const pairs = statuses.flatMap((f) => statuses.map((t) => ({ f, t })));
    const rows = await db.execute<{ f: string; t: string; ok: boolean }>(sql`
      select f, t, public.movement_can_transition(f, t) as ok
      from unnest(${sql.raw(`array[${pairs.map((p) => `'${p.f}'`).join(",")}]`)}::text[]) with ordinality as a(f, i)
      join unnest(${sql.raw(`array[${pairs.map((p) => `'${p.t}'`).join(",")}]`)}::text[]) with ordinality as b(t, j) on a.i = b.j
    `);
    expect(rows).toHaveLength(pairs.length);
    for (const r of rows) {
      const expected = MOVEMENT_TRANSITIONS[r.f as keyof typeof MOVEMENT_TRANSITIONS].includes(
        r.t as never,
      );
      expect(r.ok, `${r.f} -> ${r.t}`).toBe(expected);
    }
  });
});

describe("movement triggers", () => {
  it("numbers are per-org, per-year and sequential", async () => {
    const a = await createDraft(dispatcherA);
    const b = await createDraft(dispatcherA);
    expect(a.movementNumber).toMatch(/^ACE-\d{2}-\d{5}$/);
    const na = Number(a.movementNumber.slice(-5));
    const nb = Number(b.movementNumber.slice(-5));
    expect(nb).toBe(na + 1);
  });

  it("rejects invalid transitions at the DB level", async () => {
    const m = await createDraft(dispatcherA);
    const msg = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx.update(movements).set({ status: "released" }).where(eq(movements.id, m.id)),
      ),
    );
    expect(msg).toMatch(/invalid movement transition draft -> released/);
  });

  it("freezes header + cargo once sent; stamps submitted_at", async () => {
    const m = await createDraft(dispatcherA);
    await withRls(db, as(dispatcherA), (tx) =>
      tx.insert(cargo).values({
        movementId: m.id,
        organizationId: dispatcherA.orgId,
        commodityDescription: "Lumber",
      }),
    );
    const [sent] = await withRls(db, as(dispatcherA), (tx) =>
      tx.update(movements).set({ status: "sent" }).where(eq(movements.id, m.id)).returning(),
    );
    expect(sent!.submittedAt).not.toBeNull();

    const headerMsg = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx.update(movements).set({ tripNumber: "changed" }).where(eq(movements.id, m.id)),
      ),
    );
    expect(headerMsg).toMatch(/not editable in status sent/);

    const cargoMsg = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx.insert(cargo).values({
          movementId: m.id,
          organizationId: dispatcherA.orgId,
          commodityDescription: "Sneaky extra line",
        }),
      ),
    );
    expect(cargoMsg).toMatch(/not editable in status sent/);
  });

  it("movement_events is append-only", async () => {
    const m = await createDraft(dispatcherA);
    const [ev] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(movementEvents)
        .values({
          movementId: m.id,
          organizationId: dispatcherA.orgId,
          eventType: "note",
          actorType: "user",
          actorId: dispatcherA.userId,
          payload: { body: "hi" },
        })
        .returning(),
    );
    const msg = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx
          .update(movementEvents)
          .set({ payload: { body: "edited" } })
          .where(eq(movementEvents.id, ev!.id)),
      ),
    );
    expect(msg).toMatch(/append-only|permission denied/);
  });
});

describe("movements RLS", () => {
  it("read-only can read but not create movements", async () => {
    const rows = await withRls(db, as(readOnlyA), (tx) => tx.select().from(movements));
    expect(rows.every((r) => r.organizationId === readOnlyA.orgId)).toBe(true);
    const msg = await rejection(
      withRls(db, as(readOnlyA), (tx) =>
        tx
          .insert(movements)
          .values({ organizationId: readOnlyA.orgId, regime: "ACE", movementNumber: "X-1" })
          .returning(),
      ),
    );
    expect(msg).toMatch(/row-level security/);
  });

  it("Org B cannot see or touch Org A movements", async () => {
    const m = await createDraft(dispatcherA);
    const seen = await withRls(db, as(ownerB), (tx) =>
      tx.select().from(movements).where(eq(movements.id, m.id)),
    );
    expect(seen).toHaveLength(0);
    const updated = await withRls(db, as(ownerB), (tx) =>
      tx.update(movements).set({ status: "cancelled" }).where(eq(movements.id, m.id)).returning(),
    );
    expect(updated).toHaveLength(0);
    const events = await withRls(db, as(ownerB), (tx) =>
      tx.select().from(movementEvents).where(eq(movementEvents.movementId, m.id)),
    );
    expect(events).toHaveLength(0);
  });
});
