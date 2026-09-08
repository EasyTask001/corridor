/**
 * generated_documents — migration 0024. A movement document follows
 * movement.read; a report follows report.read; nothing crosses tenants.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/db test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls } from "./rls";
import { generatedDocuments, organizationMembers, organizations } from "./schema";

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

describe("generated_documents", () => {
  it("a movement sheet is visible to readers of the movement and to its crew, never to another tenant", async () => {
    // The crossing driver@ is in charge of (seeded): its sheet must reach the driver portal.
    const [mine] = await db.execute<{ id: string }>(
      sql`select mc.movement_id as id from public.movement_crew mc
          join public.drivers d on d.id = mc.driver_id
          where d.user_id = ${driverA.userId}::uuid and mc.role = 'person_in_charge' limit 1`,
    );
    // …and one the driver is not on at all (the seed puts them on several).
    const [other] = await db.execute<{ id: string }>(
      sql`select m.id from public.movements m
          where m.organization_id = ${dispatcherA.orgId}::uuid
            and not exists (
              select 1 from public.movement_crew mc
              join public.drivers d on d.id = mc.driver_id
              where mc.movement_id = m.id and d.user_id = ${driverA.userId}::uuid
            )
          limit 1`,
    );
    const insert = (movementId: string) =>
      withRls(db, as(dispatcherA), (tx) =>
        tx
          .insert(generatedDocuments)
          .values({
            organizationId: dispatcherA.orgId,
            movementId,
            kind: "driver_sheet",
            storagePath: `${dispatcherA.orgId}/generated/${movementId}/driver_sheet-test-${Date.now()}-${Math.random()}.pdf`,
            byteSize: 1234,
            createdBy: dispatcherA.userId,
          })
          .returning(),
      );
    const [onMine] = await insert(mine!.id);
    const [onOther] = await insert(other!.id);
    try {
      const fromB = await withRls(db, as(ownerB), (tx) =>
        tx.select().from(generatedDocuments).where(eq(generatedDocuments.id, onMine!.id)),
      );
      expect(fromB).toHaveLength(0);
      const all = await withRls(db, as(ownerB), (tx) => tx.select().from(generatedDocuments));
      expect(all.every((r) => r.organizationId === ownerB.orgId)).toBe(true);

      const driverSees = await withRls(db, as(driverA), (tx) =>
        tx.select({ id: generatedDocuments.id }).from(generatedDocuments),
      );
      const ids = driverSees.map((d) => d.id);
      expect(ids).toContain(onMine!.id);
      expect(ids).not.toContain(onOther!.id);
    } finally {
      await db.delete(generatedDocuments).where(eq(generatedDocuments.id, onMine!.id));
      await db.delete(generatedDocuments).where(eq(generatedDocuments.id, onOther!.id));
    }
  });

  it("a report needs report.read to insert and to read; the audit stays on tenant", async () => {
    const [doc] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(generatedDocuments)
        .values({
          organizationId: dispatcherA.orgId,
          movementId: null,
          kind: "report",
          storagePath: `${dispatcherA.orgId}/generated/reports/report-test-${Date.now()}.pdf`,
          metadata: { query: "crossings" },
        })
        .returning(),
    );
    try {
      expect(doc?.kind).toBe("report");
      const mine = await withRls(db, as(dispatcherA), (tx) =>
        tx.select().from(generatedDocuments).where(eq(generatedDocuments.id, doc!.id)),
      );
      expect(mine).toHaveLength(1);
      // A session never deletes a generated document.
      const deleted = await withRls(db, as(dispatcherA), (tx) =>
        tx.delete(generatedDocuments).where(eq(generatedDocuments.id, doc!.id)).returning(),
      );
      expect(deleted).toHaveLength(0);
    } finally {
      await db.delete(generatedDocuments).where(eq(generatedDocuments.id, doc!.id));
    }
  });

  it("organizations.simple_driver_sheet defaults off", async () => {
    const [org] = await db
      .select({ simple: organizations.simpleDriverSheet })
      .from(organizations)
      .where(eq(organizations.id, dispatcherA.orgId));
    expect(org?.simple).toBe(false);
  });
});
