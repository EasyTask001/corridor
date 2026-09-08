/**
 * Migration 0019: shipments + commodities. Covers the control-number trigger
 * (a denormalised copy, so CLAUDE.md requires an integration test), the
 * shipments_guard rules (regime parity, edit-lock, re-assignment window) and
 * RLS on both new tables.
 * Requires local Supabase + `pnpm db:seed`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls } from "./rls";
import { commodities, commodityHazmat, movements, organizationMembers, shipments } from "./schema";

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

let seq = 0;
const ref = () => `T${Date.now().toString(36).toUpperCase()}${seq++}`;

async function createDraftMovement(actor: Actor, regime: "ACE" | "ACI" = "ACE") {
  return withRls(db, as(actor), async (tx) => {
    const numRows = await tx.execute<{ n: string }>(
      sql`select public.next_movement_number(${actor.orgId}::uuid, ${regime}) as n`,
    );
    const [m] = await tx
      .insert(movements)
      .values({
        organizationId: actor.orgId,
        regime,
        movementNumber: numRows[0]!.n,
        createdBy: actor.userId,
      })
      .returning();
    return m!;
  });
}

/** Insert a shipment as `actor`; every field but the overrides is a sane ACE default. */
async function insertShipment(
  actor: Actor,
  over: Partial<typeof shipments.$inferInsert> = {},
): Promise<typeof shipments.$inferSelect> {
  return withRls(db, as(actor), async (tx) => {
    const [s] = await tx
      .insert(shipments)
      .values({
        organizationId: actor.orgId,
        regime: "ACE",
        carrierCode: "PFTR",
        shipmentType: "regular_bill",
        controlReference: ref(),
        ...over,
      })
      .returning();
    return s!;
  });
}

describe("shipments_control_number()", () => {
  it("fills control_number from carrier code + control reference, and keeps it in sync", async () => {
    const s = await insertShipment(dispatcherA, {
      carrierCode: "PFTR",
      controlReference: "PAPS42",
    });
    expect(s.controlNumber).toBe("PFTRPAPS42");

    const [updated] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .update(shipments)
        .set({ controlReference: "PAPS43" })
        .where(eq(shipments.id, s.id))
        .returning(),
    );
    expect(updated!.controlNumber).toBe("PFTRPAPS43");

    // A client cannot spoof it: the trigger overwrites whatever was supplied.
    const [spoofed] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .update(shipments)
        .set({ controlNumber: "SOMETHINGELSE" })
        .where(eq(shipments.id, s.id))
        .returning(),
    );
    expect(spoofed!.controlNumber).toBe("PFTRPAPS43");

    await db.delete(shipments).where(eq(shipments.id, s.id));
  });

  it("rejects a duplicate control number inside the organization", async () => {
    const a = await insertShipment(dispatcherA, { controlReference: "DUPE001" });
    const msg = await rejection(insertShipment(dispatcherA, { controlReference: "DUPE001" }));
    expect(msg).toMatch(/duplicate key|unique/i);
    await db.delete(shipments).where(eq(shipments.id, a.id));
  });
});

describe("shipments_guard()", () => {
  it("rejects a shipment whose regime differs from its movement's", async () => {
    const m = await createDraftMovement(dispatcherA, "ACE");
    const msg = await rejection(
      insertShipment(dispatcherA, {
        regime: "ACI",
        shipmentType: null,
        cargoType: "regular",
        movementId: m.id,
      }),
    );
    expect(msg).toMatch(/does not match movement regime/);
    await db.delete(movements).where(eq(movements.id, m.id));
  });

  it("blocks content edits and new commodity lines once the movement is sent", async () => {
    const m = await createDraftMovement(dispatcherA);
    const s = await insertShipment(dispatcherA, { movementId: m.id });
    await withRls(db, as(dispatcherA), (tx) =>
      tx.update(movements).set({ status: "sent" }).where(eq(movements.id, m.id)),
    );

    expect(
      await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          // notes is content; the entry number is customs-assigned and stays
          // writable after transmit (0022).
          tx.update(shipments).set({ notes: "edited after transmit" }).where(eq(shipments.id, s.id)),
        ),
      ),
    ).toMatch(/not editable in status sent/);

    expect(
      await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx.insert(commodities).values({
            shipmentId: s.id,
            organizationId: dispatcherA.orgId,
            commodityDescription: "Late line",
          }),
        ),
      ),
    ).toMatch(/not editable in status sent/);

    // The shipment's own lifecycle is not content, so it still moves.
    const [advanced] = await withRls(db, as(dispatcherA), (tx) =>
      tx.update(shipments).set({ status: "sent" }).where(eq(shipments.id, s.id)).returning(),
    );
    expect(advanced!.status).toBe("sent");

    // The movement has to go first: shipments_guard refuses to delete a
    // shipment off a transmitted manifest, and `on delete set null` detaches it.
    await db.delete(movements).where(eq(movements.id, m.id));
    await db.delete(shipments).where(eq(shipments.id, s.id));
  });

  it("only re-assigns a shipment while it is draft or rejected", async () => {
    const from = await createDraftMovement(dispatcherA);
    const to = await createDraftMovement(dispatcherA);
    const s = await insertShipment(dispatcherA, { movementId: from.id });

    const [moved] = await withRls(db, as(dispatcherA), (tx) =>
      tx.update(shipments).set({ movementId: to.id }).where(eq(shipments.id, s.id)).returning(),
    );
    expect(moved!.movementId).toBe(to.id);

    await db.update(shipments).set({ status: "accepted" }).where(eq(shipments.id, s.id));
    expect(
      await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx.update(shipments).set({ movementId: from.id }).where(eq(shipments.id, s.id)),
        ),
      ),
    ).toMatch(/can only be re-assigned while draft or rejected/);

    await db.delete(shipments).where(eq(shipments.id, s.id));
    await db.delete(movements).where(eq(movements.id, from.id));
    await db.delete(movements).where(eq(movements.id, to.id));
  });

  it("leaves an unassigned shipment freely editable", async () => {
    const s = await insertShipment(dispatcherA);
    const [line] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(commodities)
        .values({
          shipmentId: s.id,
          organizationId: dispatcherA.orgId,
          commodityDescription: "Loose line",
          quantity: 3,
          quantityUnit: "Pallet",
        })
        .returning(),
    );
    expect(line!.weightUnit).toBe("KG");

    const [withHazmat] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(commodityHazmat)
        .values({
          organizationId: dispatcherA.orgId,
          commodityId: line!.id,
          position: 1,
          unCode: "UN1203",
        })
        .returning(),
    );
    expect(withHazmat!.unCode).toBe("UN1203");

    expect(
      await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx.insert(commodityHazmat).values({
            organizationId: dispatcherA.orgId,
            commodityId: line!.id,
            position: 4,
            unCode: "UN1993",
          }),
        ),
      ),
    ).toMatch(/violates check constraint/);

    // Deleting the shipment cascades to its lines and their hazmat rows.
    await withRls(db, as(dispatcherA), (tx) => tx.delete(shipments).where(eq(shipments.id, s.id)));
    expect(await db.select().from(commodities).where(eq(commodities.id, line!.id))).toHaveLength(0);
  });
});

describe("RLS", () => {
  it("read-only can read shipments but not write them", async () => {
    const s = await insertShipment(dispatcherA);
    const seen = await withRls(db, as(readOnlyA), (tx) =>
      tx.select().from(shipments).where(eq(shipments.id, s.id)),
    );
    expect(seen).toHaveLength(1);

    // shipments_update's USING clause filters the row out, so the UPDATE is a
    // silent no-op rather than an error — the row must be unchanged.
    const updated = await withRls(db, as(readOnlyA), (tx) =>
      tx.update(shipments).set({ entryNumber: "NOPE" }).where(eq(shipments.id, s.id)).returning(),
    );
    expect(updated).toHaveLength(0);

    const insertMsg = await rejection(
      withRls(db, as(readOnlyA), (tx) =>
        tx.insert(shipments).values({
          organizationId: readOnlyA.orgId,
          regime: "ACE",
          carrierCode: "PFTR",
          shipmentType: "regular_bill",
          controlReference: ref(),
        }),
      ),
    );
    expect(insertMsg).toMatch(/row-level security/);
    await db.delete(shipments).where(eq(shipments.id, s.id));
  });

  it("cross-tenant: Org A sees zero Org B shipments, commodities and hazmat rows", async () => {
    const [foreign] = await db
      .insert(shipments)
      .values({
        organizationId: ownerB.orgId,
        regime: "ACI",
        carrierCode: "7ELU",
        cargoType: "regular",
        controlReference: `XT${Date.now().toString(36).toUpperCase()}`,
      })
      .returning();
    try {
      const [line] = await db
        .insert(commodities)
        .values({
          shipmentId: foreign!.id,
          organizationId: ownerB.orgId,
          commodityDescription: "Cross-tenant probe",
        })
        .returning();
      const [hazmat] = await db
        .insert(commodityHazmat)
        .values({
          organizationId: ownerB.orgId,
          commodityId: line!.id,
          position: 1,
          unCode: "UN1203",
        })
        .returning();

      const seenShipments = await withRls(db, as(dispatcherA), (tx) =>
        tx.select().from(shipments).where(eq(shipments.id, foreign!.id)),
      );
      const seenLines = await withRls(db, as(dispatcherA), (tx) =>
        tx.select().from(commodities).where(eq(commodities.id, line!.id)),
      );
      const seenHazmat = await withRls(db, as(dispatcherA), (tx) =>
        tx.select().from(commodityHazmat).where(eq(commodityHazmat.id, hazmat!.id)),
      );
      expect(seenShipments).toHaveLength(0);
      expect(seenLines).toHaveLength(0);
      expect(seenHazmat).toHaveLength(0);

      const all = await withRls(db, as(dispatcherA), (tx) => tx.select().from(shipments));
      expect(all.every((r) => r.organizationId === dispatcherA.orgId)).toBe(true);
      const allLines = await withRls(db, as(dispatcherA), (tx) => tx.select().from(commodities));
      expect(allLines.every((r) => r.organizationId === dispatcherA.orgId)).toBe(true);
    } finally {
      await db.delete(shipments).where(eq(shipments.id, foreign!.id));
    }
  });
});
