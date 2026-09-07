/**
 * SAML SSO (migration 0014): the anon-callable resolvers answer for a
 * configured domain, and `organization_sso` itself is invisible across tenants
 * and to members without `organization.manage`.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/db test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls, withServiceRole } from "./rls";
import { organizationMembers, organizationSso } from "./schema";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const conn = createDb(DB_URL, { max: 2 });
const db = conn.db;

/** Domains used only by this file, so a stray row cannot affect other suites. */
const DOMAIN_A = "sso-test-a.example";
const DOMAIN_A2 = "sso-test-a2.example";
const DOMAIN_B = "sso-test-b.example";
const PROVIDER_A = "mock-sso-integration-a";
const PROVIDER_B = "mock-sso-integration-b";

interface Actor {
  userId: string;
  email: string;
  orgId: string;
}

let ownerA: Actor;
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
  if (!m) throw new Error(`no membership for ${email}`);
  return { userId: user.id, email, orgId: m.orgId };
}

beforeAll(async () => {
  [ownerA, readOnlyA, ownerB] = await Promise.all([
    actorFor("owner@pathfinder.demo"),
    actorFor("readonly@pathfinder.demo"),
    actorFor("owner@northbound.demo"),
  ]);
  expect(ownerA.orgId).not.toBe(ownerB.orgId);

  await withServiceRole(db, async (tx) => {
    await tx.delete(organizationSso);
    await tx.insert(organizationSso).values([
      {
        organizationId: ownerA.orgId,
        providerId: PROVIDER_A,
        domains: [DOMAIN_A, DOMAIN_A2],
        enforced: true,
      },
      {
        organizationId: ownerB.orgId,
        providerId: PROVIDER_B,
        domains: [DOMAIN_B],
        enforced: false,
      },
    ]);
  });
});

afterAll(async () => {
  await withServiceRole(db, (tx) => tx.delete(organizationSso));
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

/**
 * Call a resolver exactly as the login page does: unauthenticated, as the
 * `anon` role, with no JWT claims at all.
 */
async function asAnon<T>(query: string, email: string): Promise<T> {
  const rows = await conn.sql.begin(async (tx) => {
    await tx.unsafe("set local role anon");
    return tx.unsafe(`select public.${query}($1::citext) as value`, [email]);
  });
  return (rows as unknown as { value: T }[])[0]!.value;
}

describe("sso_provider_for_email (anon)", () => {
  it("resolves a configured domain", async () => {
    expect(await asAnon("sso_provider_for_email", `dispatch@${DOMAIN_A}`)).toBe(PROVIDER_A);
    expect(await asAnon("sso_provider_for_email", `ops@${DOMAIN_A2}`)).toBe(PROVIDER_A);
    expect(await asAnon("sso_provider_for_email", `owner@${DOMAIN_B}`)).toBe(PROVIDER_B);
  });

  it("is case-insensitive in both the address and the stored domain", async () => {
    expect(await asAnon("sso_provider_for_email", `Dispatch@${DOMAIN_A.toUpperCase()}`)).toBe(
      PROVIDER_A,
    );
  });

  it("returns null for an unknown domain, a bare word or an empty string", async () => {
    for (const email of ["nobody@example.test", "not-an-address", "", "@example.test"]) {
      expect(await asAnon("sso_provider_for_email", email), email).toBeNull();
    }
  });

  it("does not match on a suffix of a configured domain", async () => {
    // `evil-sso-test-a.example` ends with the configured domain's text but is
    // a different domain; `any(domains)` is equality, not containment.
    expect(await asAnon("sso_provider_for_email", `x@evil-${DOMAIN_A}`)).toBeNull();
    expect(await asAnon("sso_provider_for_email", `x@sub.${DOMAIN_A}`)).toBeNull();
  });

  it("reports enforcement per configuration", async () => {
    expect(await asAnon("sso_enforced_for_email", `dispatch@${DOMAIN_A}`)).toBe(true);
    expect(await asAnon("sso_enforced_for_email", `owner@${DOMAIN_B}`)).toBe(false);
    // Unknown domain: false, never null — the login page treats it as a boolean.
    expect(await asAnon("sso_enforced_for_email", "nobody@example.test")).toBe(false);
  });

  it("does not let anon read the table the resolvers read", async () => {
    const message = await rejection(
      conn.sql.begin(async (tx) => {
        await tx.unsafe("set local role anon");
        return tx.unsafe("select * from public.organization_sso");
      }),
    );
    expect(message).toMatch(/permission denied/i);
  });
});

describe("organization_sso RLS", () => {
  it("an owner sees only their own organization's configuration", async () => {
    const rows = await withRls(db, as(ownerA), (tx) => tx.select().from(organizationSso));
    expect(rows.map((r) => r.organizationId)).toEqual([ownerA.orgId]);
    expect(rows[0]!.providerId).toBe(PROVIDER_A);
  });

  it("cross-tenant: Org A's owner gets nothing when filtering for Org B", async () => {
    const rows = await withRls(db, as(ownerA), (tx) =>
      tx.select().from(organizationSso).where(eq(organizationSso.organizationId, ownerB.orgId)),
    );
    expect(rows).toHaveLength(0);
  });

  it("cross-tenant: Org A's owner cannot update or delete Org B's configuration", async () => {
    const updated = await withRls(db, as(ownerA), (tx) =>
      tx
        .update(organizationSso)
        .set({ enforced: true, providerId: "mock-sso-hijack" })
        .where(eq(organizationSso.organizationId, ownerB.orgId))
        .returning({ organizationId: organizationSso.organizationId }),
    );
    expect(updated).toHaveLength(0);

    const deleted = await withRls(db, as(ownerA), (tx) =>
      tx
        .delete(organizationSso)
        .where(eq(organizationSso.organizationId, ownerB.orgId))
        .returning({ organizationId: organizationSso.organizationId }),
    );
    expect(deleted).toHaveLength(0);

    const [survivor] = await withServiceRole(db, (tx) =>
      tx.select().from(organizationSso).where(eq(organizationSso.organizationId, ownerB.orgId)),
    );
    expect(survivor?.providerId).toBe(PROVIDER_B);
  });

  it("cross-tenant: Org A's owner cannot insert a configuration for Org B", async () => {
    await withServiceRole(db, (tx) =>
      tx.delete(organizationSso).where(eq(organizationSso.organizationId, ownerB.orgId)),
    );
    const message = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .insert(organizationSso)
          .values({
            organizationId: ownerB.orgId,
            providerId: "mock-sso-hijack",
            domains: [DOMAIN_B],
          })
          .returning(),
      ),
    );
    expect(message).toMatch(/row-level security|permission denied/i);

    // put Org B's row back for the remaining assertions
    await withServiceRole(db, (tx) =>
      tx
        .insert(organizationSso)
        .values({ organizationId: ownerB.orgId, providerId: PROVIDER_B, domains: [DOMAIN_B] }),
    );
  });

  it("a member without organization.manage cannot read or write it", async () => {
    const rows = await withRls(db, as(readOnlyA), (tx) => tx.select().from(organizationSso));
    expect(rows).toHaveLength(0);

    const updated = await withRls(db, as(readOnlyA), (tx) =>
      tx
        .update(organizationSso)
        .set({ enforced: false })
        .where(eq(organizationSso.organizationId, readOnlyA.orgId))
        .returning({ organizationId: organizationSso.organizationId }),
    );
    expect(updated).toHaveLength(0);
  });

  it("an owner can configure and remove their own", async () => {
    const updated = await withRls(db, as(ownerA), (tx) =>
      tx
        .update(organizationSso)
        .set({ enforced: false })
        .where(eq(organizationSso.organizationId, ownerA.orgId))
        .returning({ enforced: organizationSso.enforced }),
    );
    expect(updated).toEqual([{ enforced: false }]);

    // restore, so the resolver assertions above stay true if re-run
    await withRls(db, as(ownerA), (tx) =>
      tx
        .update(organizationSso)
        .set({ enforced: true })
        .where(eq(organizationSso.organizationId, ownerA.orgId)),
    );
  });

  it("refuses a malformed domain list even from an owner", async () => {
    const message = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .update(organizationSso)
          .set({ domains: ["NOT-LOWER.example"] })
          .where(eq(organizationSso.organizationId, ownerA.orgId)),
      ),
    );
    expect(message).toMatch(/organization_sso_domains_shape|check constraint/i);
  });

  it("keeps updated_at moving via the shared trigger", async () => {
    const [before] = await withServiceRole(db, (tx) =>
      tx.select().from(organizationSso).where(eq(organizationSso.organizationId, ownerA.orgId)),
    );
    await withServiceRole(db, (tx) => tx.execute(sql`select pg_sleep(0.01)`));
    const [after] = await withRls(db, as(ownerA), (tx) =>
      tx
        .update(organizationSso)
        .set({ providerId: PROVIDER_A })
        .where(eq(organizationSso.organizationId, ownerA.orgId))
        .returning(),
    );
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });
});
