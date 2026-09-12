/**
 * Integration tests for migration 0042 (postal addresses as columns).
 * Requires local Supabase + `pnpm db:seed`.
 *
 * After `supabase db reset`, `pnpm db:seed` writes the new flat columns
 * directly (seed.ts no longer inserts jsonb), so the migration's own
 * `->>` backfill statements are only exercised when 0042 is applied to an
 * existing database with legacy jsonb data — not by this suite. This test
 * proves the resulting shape (six nullable text columns, jsonb gone), the
 * country check constraints, and that seeded rows round-trip through the
 * new columns.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { createDb } from "./client";
import { withServiceRole } from "./rls";
import { drivers, organizationMembers, organizations, partners } from "./schema";

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
  ownerA = await actorFor("owner@pathfinder.demo");
});

afterAll(async () => {
  await conn.sql.end();
});

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

describe("0042 address columns", () => {
  const TABLES = [
    ["partners", "address", "address"],
    ["shipments", "delivery", "delivery_address"],
    ["organizations", "billing", "billing_address"],
    ["drivers", "us_address", "us_address"],
  ] as const;

  it("every table has the six nullable text columns and no jsonb column left", async () => {
    for (const [table, prefix, old] of TABLES) {
      // Match the exact six column names rather than a `prefix_%` LIKE: the
      // `billing` prefix would otherwise also sweep in the unrelated,
      // pre-existing `billing_email` column on organizations.
      const expected = ["city", "country", "line1", "line2", "postal_code", "region"].map(
        (p) => `${prefix}_${p}`,
      );
      const cols = await conn.sql<
        { column_name: string; data_type: string; is_nullable: string }[]
      >`
        select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = ${table} and column_name = any(${expected})
        order by column_name`;
      expect(cols.map((c) => c.column_name)).toEqual([...expected].sort());
      expect(cols.every((c) => c.data_type === "text" && c.is_nullable === "YES")).toBe(true);
      const gone = await conn.sql`select 1 from information_schema.columns
        where table_schema = 'public' and table_name = ${table} and column_name = ${old}`;
      expect(gone).toHaveLength(0);
    }
  });

  it("the country check constraints exist and reject a non-ISO value", async () => {
    const checks = await conn.sql<{ conname: string }[]>`
      select conname from pg_constraint where contype = 'c' and conname in
        ('partners_address_country_check','shipments_delivery_country_check',
         'organizations_billing_country_check','drivers_us_address_country_check')`;
    expect(checks.map((c) => c.conname).sort()).toEqual([
      "drivers_us_address_country_check",
      "organizations_billing_country_check",
      "partners_address_country_check",
      "shipments_delivery_country_check",
    ]);
    const msg = await rejection(
      withServiceRole(db, (tx) =>
        tx
          .insert(partners)
          .values({
            organizationId: ownerA.orgId,
            name: "Bad Country Co",
            type: "shipper",
            addressCountry: "usa",
          })
          .returning(),
      ),
    );
    expect(msg).toMatch(/partners_address_country_check/);
  });

  it("seed rows carry their address in the new columns", async () => {
    const [partner] = await db
      .select({ city: partners.addressCity, country: partners.addressCountry })
      .from(partners)
      .where(
        and(eq(partners.organizationId, ownerA.orgId), eq(partners.name, "Maple Ridge Steel Ltd")),
      );
    expect(partner).toEqual({ city: "Hamilton", country: "CA" });
    const [passenger] = await db
      .select({ city: drivers.usAddressCity, region: drivers.usAddressRegion })
      .from(drivers)
      .where(and(eq(drivers.organizationId, ownerA.orgId), eq(drivers.lastName, "Delgado")));
    expect(passenger).toEqual({ city: "Detroit", region: "MI" });
    const [org] = await db
      .select({ city: organizations.billingCity, postal: organizations.billingPostalCode })
      .from(organizations)
      .where(eq(organizations.id, ownerA.orgId));
    expect(org).toEqual({ city: "Mississauga", postal: "L5T 2M8" });
  });
});
