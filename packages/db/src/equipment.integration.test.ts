/**
 * Multi-trailer, per-trailer seals, equipment types and extra plates —
 * migration 0021.
 *
 *   * equipment_types is a shared, non-tenant catalogue, read-only from a session.
 *   * movement_trailers / equipment_plates are tenant data: invisible across
 *     tenants, and a session cannot attach another org's unit even while
 *     naming its own organization (composite foreign keys).
 *   * seals_limit(): 4 seals per trailer, 1 on the truck, and a seal can only
 *     go on a slot of its own movement.
 *   * movements_guard() (rebuilt here) still freezes the header once sent, and
 *     is_empty is part of that header.
 *   * a crew member sees the trailers of the crossing they are on.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/db test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls } from "./rls";
import {
  equipmentPlates,
  equipmentTypes,
  movementTrailers,
  movements,
  organizationMembers,
  seals,
  trailers,
  trucks,
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
  [dispatcherA, driverA, ownerB] = await Promise.all([
    actorFor("dispatch@pathfinder.demo"),
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

const seededTrailer = (actor: Actor, unit: string) =>
  db
    .select()
    .from(trailers)
    .where(and(eq(trailers.organizationId, actor.orgId), eq(trailers.unitNumber, unit)))
    .then((r) => r[0]!);

describe("equipment_types", () => {
  it("is a shared catalogue readable by every organization", async () => {
    const [fromA, fromB] = await Promise.all([
      withRls(db, as(dispatcherA), (tx) => tx.select().from(equipmentTypes)),
      withRls(db, as(ownerB), (tx) => tx.select().from(equipmentTypes)),
    ]);
    expect(fromA.length).toBeGreaterThan(40);
    expect(fromB.length).toBe(fromA.length);
    expect(fromA.map((t) => t.code)).toEqual(expect.arrayContaining(["TF", "RT", "FT", "CH"]));
  });

  it("is read-only from a session", async () => {
    await expect(
      withRls(db, as(dispatcherA), (tx) =>
        tx.insert(equipmentTypes).values({ code: "ZZ", label: "Nope" }),
      ),
    ).rejects.toThrow();
  });

  it("the seeded trailers carry CBP codes and a trailer cannot use an unknown one", async () => {
    const tr501 = await seededTrailer(dispatcherA, "TR-501");
    expect(tr501.trailerType).toBe("TF");
    const msg = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx
          .update(trailers)
          .set({ trailerType: "XX" })
          .where(eq(trailers.id, tr501.id))
          .returning(),
      ),
    );
    expect(msg).toMatch(/trailers_trailer_type_fkey/);
  });
});

describe("movement_trailers", () => {
  it("cross-tenant: Org A sees zero Org B rows, even by id", async () => {
    const [foreignMovement] = await db
      .insert(movements)
      .values({
        organizationId: ownerB.orgId,
        regime: "ACE",
        movementNumber: `XT-MT-${Date.now()}`,
      })
      .returning({ id: movements.id });
    const [foreignTrailer] = await db
      .insert(trailers)
      .values({
        organizationId: ownerB.orgId,
        unitNumber: `TR-XT-${Date.now()}`,
        plateNumber: "XT0002",
        plateJurisdiction: "BC",
      })
      .returning({ id: trailers.id });
    try {
      const [slot] = await db
        .insert(movementTrailers)
        .values({
          organizationId: ownerB.orgId,
          movementId: foreignMovement!.id,
          trailerId: foreignTrailer!.id,
        })
        .returning({ id: movementTrailers.id });
      const seen = await withRls(db, as(dispatcherA), (tx) =>
        tx.select().from(movementTrailers).where(eq(movementTrailers.id, slot!.id)),
      );
      expect(seen).toHaveLength(0);
      const all = await withRls(db, as(dispatcherA), (tx) => tx.select().from(movementTrailers));
      expect(all.every((r) => r.organizationId === dispatcherA.orgId)).toBe(true);

      // Naming my own org does not let me hitch somebody else's trailer.
      const mine = await createDraft(dispatcherA);
      const msg = await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx
            .insert(movementTrailers)
            .values({
              organizationId: dispatcherA.orgId,
              movementId: mine.id,
              trailerId: foreignTrailer!.id,
            })
            .returning(),
        ),
      );
      expect(msg).toMatch(/movement_trailers_trailer_id_fkey/);
      await db.delete(movements).where(eq(movements.id, mine.id));
    } finally {
      await db.delete(movements).where(eq(movements.id, foreignMovement!.id));
      await db.delete(trailers).where(eq(trailers.id, foreignTrailer!.id));
    }
  });

  it("keeps tow order and refuses the same trailer twice", async () => {
    const m = await createDraft(dispatcherA);
    const [tr501, tr502] = await Promise.all([
      seededTrailer(dispatcherA, "TR-501"),
      seededTrailer(dispatcherA, "TR-502"),
    ]);
    try {
      await withRls(db, as(dispatcherA), (tx) =>
        tx.insert(movementTrailers).values([
          { organizationId: dispatcherA.orgId, movementId: m.id, trailerId: tr502.id, position: 2 },
          { organizationId: dispatcherA.orgId, movementId: m.id, trailerId: tr501.id, position: 1 },
        ]),
      );
      const tow = await withRls(db, as(dispatcherA), (tx) =>
        tx
          .select({ trailerId: movementTrailers.trailerId })
          .from(movementTrailers)
          .where(eq(movementTrailers.movementId, m.id))
          .orderBy(movementTrailers.position),
      );
      expect(tow.map((t) => t.trailerId)).toEqual([tr501.id, tr502.id]);
      const dup = await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx
            .insert(movementTrailers)
            .values({ organizationId: dispatcherA.orgId, movementId: m.id, trailerId: tr501.id })
            .returning(),
        ),
      );
      expect(dup).toMatch(/movement_trailers_movement_id_trailer_id_key/);
    } finally {
      await db.delete(movements).where(eq(movements.id, m.id));
    }
  });

  it("a crew member sees the trailers of their crossing through movement_trailers", async () => {
    // The seed puts Gurpreet Singh (driver@) in charge of a double: TR-501 + TR-502.
    const seen = await withRls(db, as(driverA), (tx) =>
      tx.select({ unitNumber: trailers.unitNumber }).from(trailers),
    );
    expect(seen.map((t) => t.unitNumber)).toEqual(expect.arrayContaining(["TR-501", "TR-502"]));
  });
});

describe("seals_limit()", () => {
  it("allows four seals per trailer, one on the truck, and only on this movement's slots", async () => {
    const m = await createDraft(dispatcherA);
    const other = await createDraft(dispatcherA);
    const tr501 = await seededTrailer(dispatcherA, "TR-501");
    const tr502 = await seededTrailer(dispatcherA, "TR-502");
    try {
      const [slot] = await withRls(db, as(dispatcherA), (tx) =>
        tx
          .insert(movementTrailers)
          .values({ organizationId: dispatcherA.orgId, movementId: m.id, trailerId: tr501.id })
          .returning({ id: movementTrailers.id }),
      );
      const [otherSlot] = await withRls(db, as(dispatcherA), (tx) =>
        tx
          .insert(movementTrailers)
          .values({
            organizationId: dispatcherA.orgId,
            movementId: other.id,
            trailerId: tr502.id,
          })
          .returning({ id: movementTrailers.id }),
      );
      const seal = (n: string, movementTrailerId: string | null) =>
        withRls(db, as(dispatcherA), (tx) =>
          tx
            .insert(seals)
            .values({
              movementId: m.id,
              organizationId: dispatcherA.orgId,
              movementTrailerId,
              sealNumber: n,
            })
            .returning(),
        );

      for (const n of ["S1", "S2", "S3", "S4"]) await seal(n, slot!.id);
      expect(await rejection(seal("S5", slot!.id))).toMatch(/at most 4 seal\(s\) per trailer/);

      await seal("T1", null);
      expect(await rejection(seal("T2", null))).toMatch(/at most 1 seal\(s\) per truck/);

      expect(await rejection(seal("X1", otherSlot!.id))).toMatch(/not on this movement/);

      // Dropping the trailer takes its seals with it; the truck seal stays.
      await withRls(db, as(dispatcherA), (tx) =>
        tx.delete(movementTrailers).where(eq(movementTrailers.id, slot!.id)),
      );
      const left = await withRls(db, as(dispatcherA), (tx) =>
        tx.select({ n: seals.sealNumber }).from(seals).where(eq(seals.movementId, m.id)),
      );
      expect(left.map((s) => s.n)).toEqual(["T1"]);
    } finally {
      await db.delete(movements).where(eq(movements.id, m.id));
      await db.delete(movements).where(eq(movements.id, other.id));
    }
  });
});

describe("movements_guard() after 0021", () => {
  it("still freezes the header once sent — is_empty included — and the tow with it", async () => {
    const m = await createDraft(dispatcherA);
    const tr501 = await seededTrailer(dispatcherA, "TR-501");
    try {
      await withRls(db, as(dispatcherA), (tx) =>
        tx
          .insert(movementTrailers)
          .values({ organizationId: dispatcherA.orgId, movementId: m.id, trailerId: tr501.id }),
      );
      await withRls(db, as(dispatcherA), (tx) =>
        tx.update(movements).set({ status: "sent" }).where(eq(movements.id, m.id)),
      );
      const flag = await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx.update(movements).set({ isEmpty: true }).where(eq(movements.id, m.id)).returning(),
        ),
      );
      expect(flag).toMatch(/not editable in status sent/);
      const tow = await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx.delete(movementTrailers).where(eq(movementTrailers.movementId, m.id)).returning(),
        ),
      );
      expect(tow).toMatch(/not editable in status sent/);
    } finally {
      await db.delete(movements).where(eq(movements.id, m.id));
    }
  });
});

describe("equipment_plates", () => {
  it("cross-tenant: Org A sees zero Org B rows; a plate must sit on exactly one unit", async () => {
    const [foreignTruck] = await db
      .insert(trucks)
      .values({
        organizationId: ownerB.orgId,
        unitNumber: `T-XT-${Date.now()}`,
        plateNumber: "XT0003",
        plateJurisdiction: "BC",
      })
      .returning({ id: trucks.id });
    try {
      const [plate] = await db
        .insert(equipmentPlates)
        .values({
          organizationId: ownerB.orgId,
          truckId: foreignTruck!.id,
          plateNumber: "XT0003A",
          jurisdiction: "AB",
          position: 1,
        })
        .returning({ id: equipmentPlates.id });
      const seen = await withRls(db, as(dispatcherA), (tx) =>
        tx.select().from(equipmentPlates).where(eq(equipmentPlates.id, plate!.id)),
      );
      expect(seen).toHaveLength(0);
      const all = await withRls(db, as(dispatcherA), (tx) => tx.select().from(equipmentPlates));
      expect(all.every((r) => r.organizationId === dispatcherA.orgId)).toBe(true);

      // My org, their truck: the composite key refuses it.
      const cross = await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx
            .insert(equipmentPlates)
            .values({
              organizationId: dispatcherA.orgId,
              truckId: foreignTruck!.id,
              plateNumber: "SNEAK1",
              jurisdiction: "ON",
              // 2, so the (truck_id, position) unique index is not what rejects it.
              position: 2,
            })
            .returning(),
        ),
      );
      expect(cross).toMatch(/equipment_plates_truck_id_fkey/);
    } finally {
      await db.delete(trucks).where(eq(trucks.id, foreignTruck!.id));
    }

    const tr501 = await seededTrailer(dispatcherA, "TR-501");
    const [t101] = await db
      .select()
      .from(trucks)
      .where(and(eq(trucks.organizationId, dispatcherA.orgId), eq(trucks.unitNumber, "T-101")));
    const both = await rejection(
      withRls(db, as(dispatcherA), (tx) =>
        tx
          .insert(equipmentPlates)
          .values({
            organizationId: dispatcherA.orgId,
            truckId: t101!.id,
            trailerId: tr501.id,
            plateNumber: "BOTH1",
            jurisdiction: "ON",
            position: 4,
          })
          .returning(),
      ),
    );
    expect(both).toMatch(/equipment_plates_owner_check/);
  });
});
