/**
 * RLS integration tests for Phase 1 registries + compliance_alerts.
 * Requires local Supabase + `pnpm db:seed`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { createDb } from "./client";
import { withRls } from "./rls";
import {
  complianceAlerts,
  drivers,
  organizationMembers,
  partners,
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
let ownerA: Actor;
let readOnlyA: Actor;
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
  [ownerA, readOnlyA, dispatcherA, ownerB] = await Promise.all([
    actorFor("owner@pathfinder.demo"),
    actorFor("readonly@pathfinder.demo"),
    actorFor("dispatch@pathfinder.demo"),
    actorFor("owner@northbound.demo"),
  ]);
});

afterAll(async () => {
  await conn.sql.end();
});

const as = (a: Actor) => ({ sub: a.userId, email: a.email });

async function expectRlsDenied(p: Promise<unknown>) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, "expected the query to be rejected").toBeDefined();
  const messages: string[] = [];
  for (let e = err; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join(" | ")).toMatch(/permission denied|row-level security/i);
}

describe("registries RLS", () => {
  it("Org A sees only Org A drivers; Org B's seeded driver is invisible", async () => {
    const rows = await withRls(db, as(ownerA), (tx) => tx.select().from(drivers));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ownerA.orgId)).toBe(true);
    expect(rows.some((r) => r.lastName === "Bergstrom")).toBe(false);
  });

  it("Org B owner sees exactly their one driver", async () => {
    const rows = await withRls(db, as(ownerB), (tx) => tx.select().from(drivers));
    expect(rows.map((r) => r.lastName)).toEqual(["Bergstrom"]);
  });

  it("read-only member can read but not write drivers", async () => {
    const rows = await withRls(db, as(readOnlyA), (tx) => tx.select().from(drivers));
    expect(rows.length).toBeGreaterThan(0);
    await expectRlsDenied(
      withRls(db, as(readOnlyA), (tx) =>
        tx
          .insert(drivers)
          .values({
            organizationId: readOnlyA.orgId,
            firstName: "No",
            lastName: "Access",
            licenseNumber: "X",
            licenseJurisdiction: "ON",
          })
          .returning(),
      ),
    );
  });

  it("dispatcher can create a truck and it is scoped to their org", async () => {
    const [row] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(trucks)
        .values({
          organizationId: dispatcherA.orgId,
          unitNumber: `T-TEST-${Date.now()}`,
          plateNumber: "TEST123",
          plateJurisdiction: "ON",
        })
        .returning(),
    );
    expect(row?.organizationId).toBe(dispatcherA.orgId);
    // Org B cannot see it
    const fromB = await withRls(db, as(ownerB), (tx) =>
      tx.select().from(trucks).where(eq(trucks.id, row!.id)),
    );
    expect(fromB).toHaveLength(0);
    // cleanup
    await db.delete(trucks).where(eq(trucks.id, row!.id));
  });

  it("cannot insert a partner into another org even with write permission at home", async () => {
    await expectRlsDenied(
      withRls(db, as(ownerA), (tx) =>
        tx
          .insert(partners)
          .values({ organizationId: ownerB.orgId, name: "Sneaky Co", type: "shipper" })
          .returning(),
      ),
    );
  });

  it("cross-tenant: Org A sees zero Org B trailers rows", async () => {
    const [foreign] = await db
      .insert(trailers)
      .values({
        organizationId: ownerB.orgId,
        unitNumber: `TR-XT-${Date.now()}`,
        plateNumber: "XT0001",
        plateJurisdiction: "BC",
      })
      .returning({ id: trailers.id });
    try {
      const targeted = await withRls(db, as(ownerA), (tx) =>
        tx.select().from(trailers).where(eq(trailers.id, foreign!.id)),
      );
      expect(targeted).toHaveLength(0);
      const all = await withRls(db, as(ownerA), (tx) => tx.select().from(trailers));
      expect(all.every((r) => r.organizationId === ownerA.orgId)).toBe(true);
    } finally {
      await db.delete(trailers).where(eq(trailers.id, foreign!.id));
    }
  });

  it("cross-tenant update of a driver returns zero rows", async () => {
    const [target] = await withRls(db, as(ownerB), (tx) => tx.select().from(drivers).limit(1));
    const updated = await withRls(db, as(ownerA), (tx) =>
      tx
        .update(drivers)
        .set({ firstName: "Hacked" })
        .where(eq(drivers.id, target!.id))
        .returning({ id: drivers.id }),
    );
    expect(updated).toHaveLength(0);
  });
});

describe("compliance_alerts RLS", () => {
  it("alerts are tenant-scoped and readable by read-only (alert.read)", async () => {
    const rows = await withRls(db, as(readOnlyA), (tx) => tx.select().from(complianceAlerts));
    expect(rows.every((r) => r.organizationId === readOnlyA.orgId)).toBe(true);
  });

  it("Org A cannot see Org B alerts even when filtering explicitly", async () => {
    const rows = await withRls(db, as(ownerA), (tx) =>
      tx
        .select()
        .from(complianceAlerts)
        .where(and(eq(complianceAlerts.organizationId, ownerB.orgId))),
    );
    expect(rows).toHaveLength(0);
  });
});
