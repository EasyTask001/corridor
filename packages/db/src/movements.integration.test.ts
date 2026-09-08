/**
 * Phase 2 integration tests: DB-level state machine parity with the domain
 * table, edit-lock triggers, append-only events, RLS on movements.
 * Requires local Supabase + `pnpm db:seed`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq, inArray, sql } from "drizzle-orm";
import { MOVEMENT_TRANSITIONS, movementStatus } from "@corridor/domain";
import { createDb } from "./client";
import { withRls } from "./rls";
import {
  commodities,
  drivers,
  movementAmendments,
  movementCrew,
  movementEvents,
  movementSuggestions,
  movements,
  organizationMembers,
  permissions,
  rolePermissions,
  roles,
  seals,
  shipments,
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
let driverA: Actor;
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
  [dispatcherA, readOnlyA, driverA, ownerB] = await Promise.all([
    actorFor("dispatch@pathfinder.demo"),
    actorFor("readonly@pathfinder.demo"),
    actorFor("driver@pathfinder.demo"),
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

/** A draft shipment on `movementId`, so commodity lines have somewhere to live. */
async function createShipment(actor: Actor, movementId: string | null) {
  return withRls(db, as(actor), async (tx) => {
    const [s] = await tx
      .insert(shipments)
      .values({
        organizationId: actor.orgId,
        regime: "ACE",
        movementId,
        carrierCode: "PFTR",
        shipmentType: "regular_bill",
        controlReference: `T${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)}`,
      })
      .returning();
    return s!;
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

  it("freezes header + commodities once sent; stamps submitted_at", async () => {
    const m = await createDraft(dispatcherA);
    const shipment = await createShipment(dispatcherA, m.id);
    await withRls(db, as(dispatcherA), (tx) =>
      tx.insert(commodities).values({
        shipmentId: shipment.id,
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

    const commodityMsg = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx.insert(commodities).values({
          shipmentId: shipment.id,
          organizationId: dispatcherA.orgId,
          commodityDescription: "Sneaky extra line",
        }),
      ),
    );
    expect(commodityMsg).toMatch(/not editable in status sent/);

    // …and the shipment header itself is frozen too (shipments_guard).
    const shipmentMsg = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx.update(shipments).set({ entryNumber: "SNEAK" }).where(eq(shipments.id, shipment.id)),
      ),
    );
    expect(shipmentMsg).toMatch(/not editable in status sent/);
  });

  it("lifecycle timestamps come from the trigger, never from the client", async () => {
    // 0008 added this anti-spoof block and 0020 rebuilt movements_guard() on top
    // of it; if a rebuild ever drops it, a client could backdate a manifest.
    const m = await createDraft(dispatcherA);
    const spoofed = new Date("2000-01-01T00:00:00Z");

    const [sent] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .update(movements)
        .set({ status: "sent", submittedAt: spoofed })
        .where(eq(movements.id, m.id))
        .returning(),
    );
    expect(sent!.submittedAt!.getTime()).toBeGreaterThan(spoofed.getTime());

    const [planted] = await withRls(db, as(dispatcherA), (tx) =>
      tx.update(movements).set({ arrivedAt: spoofed }).where(eq(movements.id, m.id)).returning(),
    );
    expect(planted!.arrivedAt).toBeNull();
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

  it("Driver-Portal sees only the movements it is crew on, and their manifest details", async () => {
    const [linkedDriver] = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.userId, driverA.userId));
    expect(linkedDriver).toBeDefined();

    const crewedMovementIds = new Set(
      (
        await db
          .select({ movementId: movementCrew.movementId })
          .from(movementCrew)
          .where(eq(movementCrew.driverId, linkedDriver!.id))
      ).map((r) => r.movementId),
    );
    expect(crewedMovementIds.size).toBeGreaterThan(0);

    const assigned = await withRls(db, as(driverA), (tx) => tx.select().from(movements));
    expect(assigned.length).toBeGreaterThan(0);
    expect(assigned.every((movement) => crewedMovementIds.has(movement.id))).toBe(true);
    // Being crew is what grants it: a movement they are not on stays invisible.
    const notCrewed = await db
      .select({ id: movements.id })
      .from(movements)
      .where(eq(movements.organizationId, driverA.orgId));
    expect(notCrewed.some((m) => !crewedMovementIds.has(m.id))).toBe(true);
    expect(assigned.length).toBeLessThan(notCrewed.length);

    const assignedShipments = await withRls(db, as(driverA), (tx) =>
      tx.select().from(shipments).where(eq(shipments.movementId, assigned[0]!.id)),
    );
    expect(assignedShipments.length).toBeGreaterThan(0);
    const lines = await withRls(db, as(driverA), (tx) =>
      tx.select().from(commodities).where(eq(commodities.shipmentId, assignedShipments[0]!.id)),
    );
    const events = await withRls(db, as(driverA), (tx) =>
      tx.select().from(movementEvents).where(eq(movementEvents.movementId, assigned[0]!.id)),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
  });

  it("read-only cannot edit or transition a movement through direct SQL", async () => {
    const m = await createDraft(dispatcherA);
    const edited = await withRls(db, as(readOnlyA), (tx) =>
      tx
        .update(movements)
        .set({ tripNumber: "BYPASS" })
        .where(eq(movements.id, m.id))
        .returning({ id: movements.id }),
    );
    const transitioned = await withRls(db, as(readOnlyA), (tx) =>
      tx
        .update(movements)
        .set({ status: "sent" })
        .where(eq(movements.id, m.id))
        .returning({ id: movements.id }),
    );
    expect(edited).toHaveLength(0);
    expect(transitioned).toHaveLength(0);
  });

  it("an event cannot be attached to a movement from another organization", async () => {
    const m = await createDraft(dispatcherA);
    const msg = await rejection(
      withRls(db, as(ownerB), (tx) =>
        tx.insert(movementEvents).values({
          movementId: m.id,
          organizationId: ownerB.orgId,
          eventType: "note",
          actorType: "user",
          actorId: ownerB.userId,
          payload: { body: "cross-tenant event" },
        }),
      ),
    );
    expect(msg).toMatch(/movement .* not found|organization does not match/i);
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

  it("only draft movements are deletable, and only with movement.write (0011)", async () => {
    const draft = await createDraft(dispatcherA);
    const readOnlyAttempt = await withRls(db, as(readOnlyA), (tx) =>
      tx.delete(movements).where(eq(movements.id, draft.id)).returning({ id: movements.id }),
    );
    expect(readOnlyAttempt).toHaveLength(0);

    const sent = await createDraft(dispatcherA);
    await withRls(db, as(dispatcherA), (tx) =>
      tx.update(movements).set({ status: "sent" }).where(eq(movements.id, sent.id)),
    );
    const sentAttempt = await withRls(db, as(dispatcherA), (tx) =>
      tx.delete(movements).where(eq(movements.id, sent.id)).returning({ id: movements.id }),
    );
    expect(sentAttempt).toHaveLength(0);

    // A draft with lines and a timeline deletes too — the child guards let the
    // cascade through even though both tables reject ordinary deletes.
    const draftShipment = await createShipment(dispatcherA, draft.id);
    await withRls(db, as(dispatcherA), (tx) =>
      tx.insert(commodities).values({
        shipmentId: draftShipment.id,
        organizationId: dispatcherA.orgId,
        commodityDescription: "Line on a deletable draft",
      }),
    );
    await withRls(db, as(dispatcherA), (tx) =>
      tx.insert(movementEvents).values({
        movementId: draft.id,
        organizationId: dispatcherA.orgId,
        eventType: "note",
        actorType: "user",
        actorId: dispatcherA.userId,
        payload: { body: "created" },
      }),
    );
    const draftDeleted = await withRls(db, as(dispatcherA), (tx) =>
      tx.delete(movements).where(eq(movements.id, draft.id)).returning({ id: movements.id }),
    );
    expect(draftDeleted).toHaveLength(1);
    const orphanEvents = await db
      .select()
      .from(movementEvents)
      .where(eq(movementEvents.movementId, draft.id));
    expect(orphanEvents).toHaveLength(0);
    // `on delete set null`: the shipment survives the movement, unassigned.
    const [survivor] = await db.select().from(shipments).where(eq(shipments.id, draftShipment.id));
    expect(survivor!.movementId).toBeNull();
    const survivingLines = await db
      .select()
      .from(commodities)
      .where(eq(commodities.shipmentId, draftShipment.id));
    expect(survivingLines).toHaveLength(1);
    await db.delete(shipments).where(eq(shipments.id, draftShipment.id));
  });

  it("only draft amendments are deletable (0011)", async () => {
    const m = await createDraft(dispatcherA);
    const [draft, submitted] = await db
      .insert(movementAmendments)
      .values([
        {
          movementId: m.id,
          organizationId: dispatcherA.orgId,
          amendmentNumber: 1,
          reason: "draft amendment",
          status: "draft" as const,
        },
        {
          movementId: m.id,
          organizationId: dispatcherA.orgId,
          amendmentNumber: 2,
          reason: "submitted amendment",
        },
      ])
      .returning({ id: movementAmendments.id });

    const submittedAttempt = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .delete(movementAmendments)
        .where(eq(movementAmendments.id, submitted!.id))
        .returning({ id: movementAmendments.id }),
    );
    expect(submittedAttempt).toHaveLength(0);

    const draftDeleted = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .delete(movementAmendments)
        .where(eq(movementAmendments.id, draft!.id))
        .returning({ id: movementAmendments.id }),
    );
    expect(draftDeleted).toHaveLength(1);

    await db.delete(movements).where(eq(movements.id, m.id));
  });

  it("cross-tenant: Org A sees zero Org B seals and movement_amendments rows", async () => {
    // Built with the owning connection (not RLS) so Org B needs no fixtures.
    const [foreign] = await db
      .insert(movements)
      .values({
        organizationId: ownerB.orgId,
        regime: "ACI",
        movementNumber: `XT-${Date.now()}`,
      })
      .returning({ id: movements.id });
    try {
      const [seal] = await db
        .insert(seals)
        .values({
          movementId: foreign!.id,
          organizationId: ownerB.orgId,
          sealNumber: `XT-SEAL-${Date.now()}`,
        })
        .returning({ id: seals.id });
      const [amendment] = await db
        .insert(movementAmendments)
        .values({
          movementId: foreign!.id,
          organizationId: ownerB.orgId,
          amendmentNumber: 1,
          reason: "Cross-tenant probe",
        })
        .returning({ id: movementAmendments.id });

      const seenSeals = await withRls(db, as(dispatcherA), (tx) =>
        tx.select().from(seals).where(eq(seals.id, seal!.id)),
      );
      const seenAmendments = await withRls(db, as(dispatcherA), (tx) =>
        tx.select().from(movementAmendments).where(eq(movementAmendments.id, amendment!.id)),
      );
      expect(seenSeals).toHaveLength(0);
      expect(seenAmendments).toHaveLength(0);

      const allSeals = await withRls(db, as(dispatcherA), (tx) => tx.select().from(seals));
      const allAmendments = await withRls(db, as(dispatcherA), (tx) =>
        tx.select().from(movementAmendments),
      );
      expect(allSeals.every((r) => r.organizationId === dispatcherA.orgId)).toBe(true);
      expect(allAmendments.every((r) => r.organizationId === dispatcherA.orgId)).toBe(true);
    } finally {
      // cascades to seals / amendments
      await db.delete(movements).where(eq(movements.id, foreign!.id));
    }
  });
});

/**
 * movements_guard()'s trigger-level checks (0008_security_hardening.sql:43-133,
 * carried forward by 0018 with only the manifest-changed expression touched
 * for port_id/carrier_code). These specifically catch a body-level regression
 * that the RLS policies alone would not: the movements_update policy's USING
 * clause is a single OR across movement.write/transmit_to_customs/amend/cancel,
 * so a caller holding only movement.write reaches the trigger for a
 * transition it has no business making, and the "movement identity fields are
 * immutable" check runs on every UPDATE a full-write caller can otherwise make.
 */
describe("movements_guard() permission + identity checks (0008)", () => {
  it("a caller holding only movement.write (and movement.read) cannot flip status to sent — that transition needs movement.transmit_to_customs", async () => {
    const roleName = `Write-only test role ${Date.now()}`;
    const [tempRole] = await db
      .insert(roles)
      .values({ organizationId: dispatcherA.orgId, name: roleName, isSystem: false })
      .returning({ id: roles.id });
    // movement.read too — createDraft()'s `.returning()` needs the movements
    // select policy to pass for the just-inserted row, same as any real
    // custom role that can create movements would also be able to read them.
    const grantedPermissions = await db
      .select({ id: permissions.id })
      .from(permissions)
      .where(inArray(permissions.key, ["movement.write", "movement.read"]));
    expect(grantedPermissions).toHaveLength(2);
    await db
      .insert(rolePermissions)
      .values(grantedPermissions.map((p) => ({ roleId: tempRole!.id, permissionId: p.id })));

    const [membership] = await db
      .select({ id: organizationMembers.id, roleId: organizationMembers.roleId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, dispatcherA.userId));

    try {
      await db
        .update(organizationMembers)
        .set({ roleId: tempRole!.id })
        .where(eq(organizationMembers.id, membership!.id));

      const m = await createDraft(dispatcherA);
      const msg = await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx.update(movements).set({ status: "sent" }).where(eq(movements.id, m.id)).returning(),
        ),
      );
      expect(msg).toMatch(/permission denied: movement\.transmit_to_customs required/);

      // Read-only (no write permission at all) is refused earlier, by the
      // movements_update RLS policy itself — 0 rows, not an exception. Both
      // layers have to hold for the transition to be genuinely blocked.
      const readOnlyAttempt = await withRls(db, as(readOnlyA), (tx) =>
        tx
          .update(movements)
          .set({ status: "sent" })
          .where(eq(movements.id, m.id))
          .returning({ id: movements.id }),
      );
      expect(readOnlyAttempt).toHaveLength(0);
    } finally {
      await db
        .update(organizationMembers)
        .set({ roleId: membership!.roleId })
        .where(eq(organizationMembers.id, membership!.id));
      await db.delete(rolePermissions).where(eq(rolePermissions.roleId, tempRole!.id));
      await db.delete(roles).where(eq(roles.id, tempRole!.id));
    }
  });

  it("movement_number (and the rest of a movement's identity) is immutable even for a full-write caller", async () => {
    const m = await createDraft(dispatcherA);
    const msg = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx
          .update(movements)
          .set({ movementNumber: `${m.movementNumber}-TAMPERED` })
          .where(eq(movements.id, m.id))
          .returning(),
      ),
    );
    expect(msg).toMatch(/movement identity fields are immutable/);

    // Unchanged in the DB — the statement was rejected, not silently ignored.
    const [unchanged] = await db.select().from(movements).where(eq(movements.id, m.id));
    expect(unchanged!.movementNumber).toBe(m.movementNumber);
  });
});

describe("movement_crew", () => {
  it("allows exactly one person in charge per crossing", async () => {
    const m = await createDraft(dispatcherA);
    const roster = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.organizationId, dispatcherA.orgId))
      .limit(2);
    expect(roster).toHaveLength(2);

    await withRls(db, as(dispatcherA), (tx) =>
      tx.insert(movementCrew).values({
        organizationId: dispatcherA.orgId,
        movementId: m.id,
        driverId: roster[0]!.id,
        role: "person_in_charge",
      }),
    );
    const second = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx.insert(movementCrew).values({
          organizationId: dispatcherA.orgId,
          movementId: m.id,
          driverId: roster[1]!.id,
          role: "person_in_charge",
        }),
      ),
    );
    expect(second).toMatch(/movement_crew_pic_unique|duplicate key/i);

    // The same person cannot be listed twice on one crossing either.
    const duplicate = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx.insert(movementCrew).values({
          organizationId: dispatcherA.orgId,
          movementId: m.id,
          driverId: roster[0]!.id,
          role: "crew_member",
        }),
      ),
    );
    expect(duplicate).toMatch(/duplicate key/i);
  });

  it("is frozen once the movement has been transmitted", async () => {
    const m = await createDraft(dispatcherA);
    const [driver] = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.organizationId, dispatcherA.orgId))
      .limit(1);
    await withRls(db, as(dispatcherA), (tx) =>
      tx.insert(movementCrew).values({
        organizationId: dispatcherA.orgId,
        movementId: m.id,
        driverId: driver!.id,
        role: "person_in_charge",
      }),
    );
    await db.update(movements).set({ status: "sent" }).where(eq(movements.id, m.id));

    const msg = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx.delete(movementCrew).where(eq(movementCrew.movementId, m.id)),
      ),
    );
    expect(msg).toMatch(/not editable in status sent/);
  });

  it("read-only cannot put anybody on a crossing", async () => {
    const m = await createDraft(dispatcherA);
    const [driver] = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.organizationId, dispatcherA.orgId))
      .limit(1);
    const msg = await rejection(
      withRls(db, as(readOnlyA), (tx) =>
        tx.insert(movementCrew).values({
          organizationId: readOnlyA.orgId,
          movementId: m.id,
          driverId: driver!.id,
          role: "crew_member",
        }),
      ),
    );
    expect(msg).toMatch(/row-level security/);
  });

  it("cross-tenant: Org B cannot see or add crew on an Org A crossing", async () => {
    const m = await createDraft(dispatcherA);
    const [driver] = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.organizationId, dispatcherA.orgId))
      .limit(1);
    await withRls(db, as(dispatcherA), (tx) =>
      tx.insert(movementCrew).values({
        organizationId: dispatcherA.orgId,
        movementId: m.id,
        driverId: driver!.id,
        role: "person_in_charge",
      }),
    );
    const seen = await withRls(db, as(ownerB), (tx) =>
      tx.select().from(movementCrew).where(eq(movementCrew.movementId, m.id)),
    );
    expect(seen).toHaveLength(0);
    // …and Org A cannot put one of Org B's people in its own cab either
    // (movement_crew_driver_id_fkey is composite on (id, organization_id)).
    const [foreignDriver] = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.organizationId, ownerB.orgId))
      .limit(1);
    const foreignPerson = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx.insert(movementCrew).values({
          organizationId: dispatcherA.orgId,
          movementId: m.id,
          driverId: foreignDriver!.id,
          role: "crew_member",
        }),
      ),
    );
    expect(foreignPerson).toMatch(/violates foreign key/i);
    const msg = await rejection(
      withRls(db, as(ownerB), (tx) =>
        tx.insert(movementCrew).values({
          organizationId: ownerB.orgId,
          movementId: m.id,
          driverId: driver!.id,
          role: "crew_member",
        }),
      ),
    );
    expect(msg).toMatch(/row-level security|violates foreign key|movement .* not found/i);
  });
});

describe("predictive movement suggestions", () => {
  it("tracks one immutable accept/dismiss decision and rejects cross-tenant sources", async () => {
    const own = await db
      .select()
      .from(movements)
      .where(eq(movements.organizationId, dispatcherA.orgId))
      .limit(2);
    expect(own).toHaveLength(2);
    const [foreign] = await db
      .insert(movements)
      .values({
        organizationId: ownerB.orgId,
        regime: "ACE",
        movementNumber: `TEST-SOURCE-${Date.now()}`,
      })
      .returning();
    const payload = {
      sourceMovementId: own[1]!.id,
      sourceMovementNumber: own[1]!.movementNumber,
      targetUpdatedAt: own[0]!.updatedAt.toISOString(),
      port: null,
      carrierCode: null,
      crew: [],
      truckId: null,
      trailerIds: [],
    };

    try {
      const crossTenant = await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx.insert(movementSuggestions).values({
            organizationId: dispatcherA.orgId,
            movementId: own[0]!.id,
            sourceMovementId: foreign!.id,
            score: 20,
            reasons: ["same ACE filing regime"],
            suggestedPayload: { ...payload, sourceMovementId: foreign!.id },
            createdBy: dispatcherA.userId,
          }),
        ),
      );
      expect(crossTenant).toMatch(/must belong to its organization/i);

      const [suggestion] = await withRls(db, as(dispatcherA), (tx) =>
        tx
          .insert(movementSuggestions)
          .values({
            organizationId: dispatcherA.orgId,
            movementId: own[0]!.id,
            sourceMovementId: own[1]!.id,
            score: 20,
            reasons: ["same ACE filing regime"],
            suggestedPayload: payload,
            createdBy: dispatcherA.userId,
          })
          .returning(),
      );
      await withRls(db, as(dispatcherA), (tx) =>
        tx
          .update(movementSuggestions)
          .set({ status: "accepted" })
          .where(eq(movementSuggestions.id, suggestion!.id)),
      );
      const secondDecision = await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx
            .update(movementSuggestions)
            .set({ status: "dismissed" })
            .where(eq(movementSuggestions.id, suggestion!.id)),
        ),
      );
      expect(secondDecision).toMatch(/decision cannot be changed/i);
      await db.delete(movementSuggestions).where(eq(movementSuggestions.id, suggestion!.id));
    } finally {
      await db.delete(movements).where(eq(movements.id, foreign!.id));
    }
  });
});
