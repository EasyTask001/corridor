/**
 * Port master (global) + multi-carrier codes (tenant) — migration 0018.
 *
 *   * ports is a shared, non-tenant catalogue: every org sees the same active
 *     rows.
 *   * organization_carrier_codes is tenant data: readable by any active org
 *     member (movement.options needs it for every dispatcher, regardless of
 *     whether their role also holds organization.read), writable only with
 *     `organization.manage`, and invisible across tenants like every other
 *     RLS-scoped table.
 *   * the partial unique index allows only one default code per org + regime.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/db test:integration
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { createDb } from "./client";
import { withRls, withServiceRole } from "./rls";
import { organizationCarrierCodes, organizationMembers, ports } from "./schema";

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
  if (!m) throw new Error(`no membership for ${email}`);
  return { userId: user.id, email, orgId: m.orgId };
}

beforeAll(async () => {
  [ownerA, readOnlyA, driverA, ownerB] = await Promise.all([
    actorFor("owner@pathfinder.demo"),
    actorFor("readonly@pathfinder.demo"),
    // driver_portal (see role.ts) grants only movement.read_assigned +
    // document.upload — no organization.read — which is exactly the shape a
    // custom role with movement.read-but-not-organization.read would have.
    actorFor("driver@pathfinder.demo"),
    actorFor("owner@northbound.demo"),
  ]);
  expect(ownerA.orgId).not.toBe(ownerB.orgId);
});

afterAll(async () => {
  await withServiceRole(db, (tx) =>
    tx
      .delete(organizationCarrierCodes)
      .where(eq(organizationCarrierCodes.label, "integration-test")),
  );
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

describe("ports (global reference table)", () => {
  it("is readable by every organization — the seeded crossing points show up for both", async () => {
    // 3801 (Detroit) exists as both a port_of_entry and an in_bond_destination
    // (CBP in-bond destinations reuse Schedule D port codes — see
    // import-ports.ts), so this pins the kind too.
    const cond = and(eq(ports.code, "3801"), eq(ports.kind, "port_of_entry"));
    const seenByA = await withRls(db, as(ownerA), (tx) => tx.select().from(ports).where(cond));
    const seenByB = await withRls(db, as(ownerB), (tx) => tx.select().from(ports).where(cond));
    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(1);
    expect(seenByA[0]!.id).toBe(seenByB[0]!.id);
    expect(seenByA[0]).toMatchObject({ regime: "ACE", kind: "port_of_entry", country: "US" });
  });

  it("the full Schedule D port list and CBSA office list are loaded (gap 7 floor)", async () => {
    const usPorts = await withRls(db, as(ownerA), (tx) =>
      tx.select().from(ports).where(eq(ports.kind, "port_of_entry")),
    );
    const cbsaOffices = await withRls(db, as(ownerA), (tx) =>
      tx.select().from(ports).where(eq(ports.kind, "cbsa_office")),
    );
    expect(usPorts.length).toBeGreaterThanOrEqual(150);
    expect(cbsaOffices.length).toBeGreaterThanOrEqual(90);
  });

  it("is read-only from a session — insert/update/delete are refused", async () => {
    const insert = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .insert(ports)
          .values({
            regime: "ACE",
            kind: "port_of_entry",
            code: "9999",
            name: "Forged",
            country: "US",
          })
          .returning(),
      ),
    );
    expect(insert).toMatch(/permission denied/i);

    const update = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx.update(ports).set({ name: "Hacked" }).where(eq(ports.code, "3801")).returning(),
      ),
    );
    expect(update).toMatch(/permission denied/i);
  });
});

describe("organization_carrier_codes (tenant table)", () => {
  it("an org member with organization.read sees only their org's codes", async () => {
    const rows = await withRls(db, as(readOnlyA), (tx) =>
      tx.select().from(organizationCarrierCodes),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ownerA.orgId)).toBe(true);
  });

  it("is readable by a member whose role holds no organization.read (e.g. driver_portal) — membership alone gates select", async () => {
    const rows = await withRls(db, as(driverA), (tx) => tx.select().from(organizationCarrierCodes));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ownerA.orgId)).toBe(true);
  });

  it("the seeded demo org carries PFTR (default ACE), PFTS and 7ELU (default ACI)", async () => {
    const rows = await withRls(db, as(ownerA), (tx) =>
      tx
        .select()
        .from(organizationCarrierCodes)
        .where(eq(organizationCarrierCodes.organizationId, ownerA.orgId)),
    );
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(byCode.PFTR).toMatchObject({ regime: "ACE", isDefault: true });
    expect(byCode.PFTS).toMatchObject({ regime: "ACE", isDefault: false });
    expect(byCode["7ELU"]).toMatchObject({ regime: "ACI", isDefault: true });
  });

  it("is isolated across tenants: org B never sees org A's rows, even by id", async () => {
    const [row] = await withRls(db, as(ownerA), (tx) =>
      tx
        .select()
        .from(organizationCarrierCodes)
        .where(eq(organizationCarrierCodes.organizationId, ownerA.orgId))
        .limit(1),
    );
    expect(row).toBeDefined();
    const seenByB = await withRls(db, as(ownerB), (tx) =>
      tx.select().from(organizationCarrierCodes).where(eq(organizationCarrierCodes.id, row!.id)),
    );
    expect(seenByB).toHaveLength(0);
  });

  it("organization.manage can add a code; organization.read alone cannot", async () => {
    const code = `T${randomUUID().slice(0, 3).toUpperCase()}`;
    const [inserted] = await withRls(db, as(ownerA), (tx) =>
      tx
        .insert(organizationCarrierCodes)
        .values({
          organizationId: ownerA.orgId,
          regime: "ACE",
          code,
          label: "integration-test",
          isDefault: false,
        })
        .returning(),
    );
    expect(inserted).toMatchObject({ organizationId: ownerA.orgId, code });

    const refused = await rejection(
      withRls(db, as(readOnlyA), (tx) =>
        tx
          .insert(organizationCarrierCodes)
          .values({
            organizationId: ownerA.orgId,
            regime: "ACE",
            code: `T${randomUUID().slice(0, 3).toUpperCase()}`,
            label: "integration-test",
          })
          .returning(),
      ),
    );
    expect(refused).toMatch(/permission denied|row-level security/i);
  });

  it("a session cannot plant a carrier code in another organization", async () => {
    const refused = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .insert(organizationCarrierCodes)
          .values({
            organizationId: ownerB.orgId,
            regime: "ACE",
            code: `X${randomUUID().slice(0, 3).toUpperCase()}`,
            label: "integration-test",
          })
          .returning(),
      ),
    );
    expect(refused).toMatch(/permission denied|row-level security/i);
  });

  it("at most one default code per organization + regime (partial unique index)", async () => {
    const refused = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .insert(organizationCarrierCodes)
          .values({
            organizationId: ownerA.orgId,
            regime: "ACE",
            code: `D${randomUUID().slice(0, 3).toUpperCase()}`,
            label: "integration-test",
            isDefault: true,
          })
          .returning(),
      ),
    );
    expect(refused).toMatch(/organization_carrier_codes_default_unique|duplicate key/i);
  });

  it("rejects a code that doesn't match the carrier-code pattern", async () => {
    const refused = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .insert(organizationCarrierCodes)
          .values({
            organizationId: ownerA.orgId,
            regime: "ACE",
            code: "too-long-and-lowercase",
            label: "integration-test",
          })
          .returning(),
      ),
    );
    expect(refused).toMatch(/violates check constraint|organization_carrier_codes_code_check/i);
  });
});
