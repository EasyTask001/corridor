/**
 * In-bond monitor and external shipments — migration 0026.
 *
 *   * external_shipments, in_bond_records and in_bond_events are tenant data
 *     under inbond.read / inbond.write, invisible across tenants;
 *   * a record has exactly one parent, one record per shipment;
 *   * in_bond_records_guard() keeps the parent and an assigned bond immutable
 *     and walks the lifecycle in order;
 *   * in_bond_events is append-only.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/db test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { createDb } from "./client";
import { withRls } from "./rls";
import {
  externalShipments,
  inBondEvents,
  inBondRecords,
  organizationMembers,
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

describe("in-bond tables (0026)", () => {
  it("dispatcher records an external shipment and its move; reader sees, cannot write; other tenant sees nothing", async () => {
    const [x] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(externalShipments)
        .values({
          organizationId: dispatcherA.orgId,
          regime: "ACE",
          controlNumber: `XT${Date.now().toString(36).toUpperCase()}`,
          originatingCarrierCode: "ABCD",
        })
        .returning(),
    );
    const [r] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(inBondRecords)
        .values({ organizationId: dispatcherA.orgId, externalShipmentId: x!.id, entryType: "TE" })
        .returning(),
    );
    try {
      const seen = await withRls(db, as(readOnlyA), (tx) =>
        tx.select().from(inBondRecords).where(eq(inBondRecords.id, r!.id)),
      );
      expect(seen).toHaveLength(1);
      const write = await withRls(db, as(readOnlyA), (tx) =>
        tx.update(inBondRecords).set({ firmsCode: "Z999" }).where(eq(inBondRecords.id, r!.id)).returning(),
      );
      expect(write).toHaveLength(0);

      for (const probe of [
        withRls(db, as(ownerB), (tx) => tx.select().from(inBondRecords).where(eq(inBondRecords.id, r!.id))),
        withRls(db, as(ownerB), (tx) => tx.select().from(externalShipments).where(eq(externalShipments.id, x!.id))),
      ]) {
        expect(await probe).toHaveLength(0);
      }
      const allB = await withRls(db, as(ownerB), (tx) => tx.select().from(inBondRecords));
      expect(allB.every((row) => row.organizationId === ownerB.orgId)).toBe(true);

      // Events follow the same permissions and are append-only.
      const [ev] = await withRls(db, as(dispatcherA), (tx) =>
        tx
          .insert(inBondEvents)
          .values({ organizationId: dispatcherA.orgId, inBondRecordId: r!.id, kind: "note", actorType: "user", actorId: dispatcherA.userId, payload: { body: "hi" } })
          .returning(),
      );
      const evB = await withRls(db, as(ownerB), (tx) => tx.select().from(inBondEvents).where(eq(inBondEvents.id, ev!.id)));
      expect(evB).toHaveLength(0);
      // A session has no update policy (zero rows), and even the owning
      // connection is stopped by the append-only trigger.
      const edited = await withRls(db, as(dispatcherA), (tx) =>
        tx.update(inBondEvents).set({ payload: { body: "edited" } }).where(eq(inBondEvents.id, ev!.id)).returning(),
      );
      expect(edited).toHaveLength(0);
      const owner = await rejection(
        db.update(inBondEvents).set({ payload: { body: "edited" } }).where(eq(inBondEvents.id, ev!.id)).returning(),
      );
      expect(owner).toMatch(/append-only/);
      // No delete grant for a session: the row survives a direct delete attempt.
      const gone = await withRls(db, as(dispatcherA), (tx) =>
        tx.delete(inBondEvents).where(eq(inBondEvents.id, ev!.id)).returning(),
      ).catch(() => []);
      expect(gone).toHaveLength(0);
    } finally {
      await db.delete(externalShipments).where(eq(externalShipments.id, x!.id));
    }
  });

  it("a record has exactly one parent and a shipment has at most one record", async () => {
    const [s] = await db
      .select({ id: shipments.id })
      .from(shipments)
      .where(eq(shipments.organizationId, dispatcherA.orgId))
      .limit(1);
    const [x] = await db
      .insert(externalShipments)
      .values({ organizationId: dispatcherA.orgId, regime: "ACE", inBondNumber: "300000001" })
      .returning();
    try {
      const both = await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx
            .insert(inBondRecords)
            .values({ organizationId: dispatcherA.orgId, shipmentId: s!.id, externalShipmentId: x!.id, entryType: "IT" })
            .returning(),
        ),
      );
      expect(both).toMatch(/in_bond_records_parent_check/);
      const neither = await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx.insert(inBondRecords).values({ organizationId: dispatcherA.orgId, entryType: "IT" }).returning(),
        ),
      );
      expect(neither).toMatch(/in_bond_records_parent_check/);
      const [first] = await withRls(db, as(dispatcherA), (tx) =>
        tx.insert(inBondRecords).values({ organizationId: dispatcherA.orgId, shipmentId: s!.id, entryType: "IT" }).returning(),
      );
      try {
        const dup = await rejection(
          withRls(db, as(dispatcherA), (tx) =>
            tx.insert(inBondRecords).values({ organizationId: dispatcherA.orgId, shipmentId: s!.id, entryType: "IE" }).returning(),
          ),
        );
        expect(dup).toMatch(/in_bond_records_shipment_unique/);
      } finally {
        await db.delete(inBondRecords).where(eq(inBondRecords.id, first!.id));
      }
      const nothing = await rejection(
        db.insert(externalShipments).values({ organizationId: dispatcherA.orgId, regime: "ACE" }).returning(),
      );
      expect(nothing).toMatch(/external_shipments_identity_check/);
    } finally {
      await db.delete(externalShipments).where(eq(externalShipments.id, x!.id));
    }
  });

  it("in_bond_records_guard(): parent and bond immutable, lifecycle in order", async () => {
    const [x] = await db
      .insert(externalShipments)
      .values({ organizationId: dispatcherA.orgId, regime: "ACE", inBondNumber: "300000002" })
      .returning();
    const [x2] = await db
      .insert(externalShipments)
      .values({ organizationId: dispatcherA.orgId, regime: "ACE", inBondNumber: "300000003" })
      .returning();
    const [r] = await db
      .insert(inBondRecords)
      .values({ organizationId: dispatcherA.orgId, externalShipmentId: x!.id, entryType: "IT", bondNumber: "300000002" })
      .returning();
    const update = (set: Partial<typeof inBondRecords.$inferInsert>) =>
      withRls(db, as(dispatcherA), (tx) => tx.update(inBondRecords).set(set).where(eq(inBondRecords.id, r!.id)).returning());
    try {
      expect(await rejection(update({ externalShipmentId: x2!.id }))).toMatch(/parent is immutable/);
      expect(await rejection(update({ bondNumber: "300000009" }))).toMatch(/immutable once assigned/);
      expect(await rejection(update({ status: "export_sent" }))).toMatch(/invalid in-bond transition open -> export_sent/);
      expect((await update({ status: "arrival_sent" }))[0]?.status).toBe("arrival_sent");
      expect((await update({ status: "arrived" }))[0]?.status).toBe("arrived");
      expect((await update({ status: "export_sent" }))[0]?.status).toBe("export_sent");
      expect((await update({ status: "exported" }))[0]?.status).toBe("exported");
      expect(await rejection(update({ status: "cancelled" }))).toMatch(/invalid in-bond transition exported -> cancelled/);
    } finally {
      await db.delete(externalShipments).where(eq(externalShipments.id, x!.id));
      await db.delete(externalShipments).where(eq(externalShipments.id, x2!.id));
    }
  });
});
