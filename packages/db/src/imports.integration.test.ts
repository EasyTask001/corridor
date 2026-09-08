/**
 * import_batches — migration 0028: written with import.run, readable with
 * shipment.read (but not writable), invisible across tenants; rows created by
 * a batch point back at it and survive the batch being deleted.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/db test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { createDb } from "./client";
import { withRls } from "./rls";
import { importBatches, organizationMembers, shipments } from "./schema";

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

describe("import_batches (0028)", () => {
  it("dispatcher writes a batch and a row pointing at it; reader sees but cannot write; other tenant sees nothing", async () => {
    const [batch] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(importBatches)
        .values({
          organizationId: dispatcherA.orgId,
          kind: "shipments",
          filename: "test.csv",
          rowCount: 1,
          okCount: 1,
          createdBy: dispatcherA.userId,
        })
        .returning(),
    );
    const [s] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(shipments)
        .values({
          organizationId: dispatcherA.orgId,
          regime: "ACE",
          carrierCode: "PFTR",
          shipmentType: "regular_bill",
          controlReference: `IMP${Date.now().toString(36).toUpperCase()}`,
          importBatchId: batch!.id,
        })
        .returning({ id: shipments.id, importBatchId: shipments.importBatchId }),
    );
    try {
      expect(s?.importBatchId).toBe(batch!.id);

      const seen = await withRls(db, as(readOnlyA), (tx) =>
        tx.select().from(importBatches).where(eq(importBatches.id, batch!.id)),
      );
      expect(seen).toHaveLength(1);
      const write = await withRls(db, as(readOnlyA), (tx) =>
        tx.update(importBatches).set({ status: "committed" }).where(eq(importBatches.id, batch!.id)).returning(),
      );
      expect(write).toHaveLength(0);

      const fromB = await withRls(db, as(ownerB), (tx) =>
        tx.select().from(importBatches).where(eq(importBatches.id, batch!.id)),
      );
      expect(fromB).toHaveLength(0);
      const all = await withRls(db, as(ownerB), (tx) => tx.select().from(importBatches));
      expect(all.every((b) => b.organizationId === ownerB.orgId)).toBe(true);

      // Removing the batch row unlinks its shipment instead of deleting it.
      await withRls(db, as(dispatcherA), (tx) =>
        tx.delete(importBatches).where(eq(importBatches.id, batch!.id)),
      );
      const [after] = await db
        .select({ importBatchId: shipments.importBatchId })
        .from(shipments)
        .where(eq(shipments.id, s!.id));
      expect(after?.importBatchId).toBeNull();
    } finally {
      await db.delete(shipments).where(eq(shipments.id, s!.id));
    }
  });
});
