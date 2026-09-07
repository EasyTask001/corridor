/**
 * Migration 0012 — Supabase Vault for integration credentials.
 *
 * The invariant under test: an org's gateway credentials can be written by a
 * member holding `integrations.manage`, are readable ONLY through a
 * service-role RPC, and are invisible to every browser-reachable role and to
 * every other tenant. Requires local Supabase + `pnpm db:seed`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls, withServiceRole } from "./rls";
import { integrationConfigs, organizationMembers } from "./schema";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const conn = createDb(DB_URL, { max: 4 });
const db = conn.db;

const PROVIDER = "cbp_ace";
const CREDS_A = { apiKey: "ace-key-A", apiSecret: "ace-secret-A" };
const CREDS_B = { apiKey: "aci-key-B" };
const SECRET_A = JSON.stringify(CREDS_A);
const SECRET_B = JSON.stringify(CREDS_B);

interface Actor {
  userId: string;
  email: string;
  orgId: string;
}
let ownerA: Actor;
let readOnlyA: Actor;
let ownerB: Actor;

function admin() {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY required");
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function actorFor(email: string): Promise<Actor> {
  const { data } = await admin().auth.admin.listUsers({ perPage: 1000 });
  const user = data?.users.find((u) => u.email === email);
  if (!user) throw new Error(`seed user ${email} missing — run pnpm db:seed`);
  const [m] = await db
    .select({ orgId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, user.id))
    .limit(1);
  return { userId: user.id, email, orgId: m!.orgId };
}

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

/** Ensure the provider row exists — store_integration_secret hangs the ref on it. */
async function ensureConfig(orgId: string) {
  await withServiceRole(db, (tx) =>
    tx
      .insert(integrationConfigs)
      .values({ organizationId: orgId, provider: PROVIDER })
      .onConflictDoNothing(),
  );
}

/**
 * Drop any secret this file left behind. Note this cannot go through
 * delete_integration_secret: that function checks has_permission(), and a
 * service-role PostgREST call has no auth.uid() to check — which is exactly
 * why the RPC pair is safe. Cleanup therefore goes straight at the tables.
 */
async function purge(orgId: string) {
  await withServiceRole(db, async (tx) => {
    await tx
      .update(integrationConfigs)
      .set({ credentialsRef: null })
      .where(
        and(
          eq(integrationConfigs.organizationId, orgId),
          eq(integrationConfigs.provider, PROVIDER),
        ),
      );
    await tx.execute(
      sql`delete from vault.secrets where name = ${`integration:${orgId}:${PROVIDER}`}`,
    );
  });
}

const credentialsRefFor = (orgId: string) =>
  withServiceRole(db, async (tx) => {
    const [row] = await tx
      .select({ ref: integrationConfigs.credentialsRef })
      .from(integrationConfigs)
      .where(
        and(
          eq(integrationConfigs.organizationId, orgId),
          eq(integrationConfigs.provider, PROVIDER),
        ),
      )
      .limit(1);
    return row?.ref ?? null;
  });

/**
 * The stored document, as the service role sees it. Compared parsed, not as a
 * string: a merge round-trips through jsonb, which normalises key order.
 */
async function readSecret(orgId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await admin().rpc("read_integration_secret", {
    p_org: orgId,
    p_provider: PROVIDER,
  });
  if (error) throw new Error(error.message);
  return typeof data === "string" ? (JSON.parse(data) as Record<string, unknown>) : null;
}

const storeAs = (actor: Actor, orgId: string, secret: string) =>
  withRls(db, as(actor), (tx) =>
    tx.execute<{ store_integration_secret: string }>(
      sql`select public.store_integration_secret(${orgId}::uuid, ${PROVIDER}, ${secret})`,
    ),
  );

beforeAll(async () => {
  [ownerA, readOnlyA, ownerB] = await Promise.all([
    actorFor("owner@pathfinder.demo"),
    actorFor("readonly@pathfinder.demo"),
    actorFor("owner@northbound.demo"),
  ]);
  await Promise.all([ensureConfig(ownerA.orgId), ensureConfig(ownerB.orgId)]);
  // Start from a known-empty vault so every assertion below is order-independent.
  await Promise.all([purge(ownerA.orgId), purge(ownerB.orgId)]);
});

afterAll(async () => {
  // Leave no plaintext behind, even on failure.
  if (ownerA && ownerB) await Promise.all([purge(ownerA.orgId), purge(ownerB.orgId)]);
  await conn.sql.end();
});

describe("integration credentials in Supabase Vault", () => {
  it("an owner stores a secret, which lands in the vault and is pointed at by credentials_ref", async () => {
    const rows = await storeAs(ownerA, ownerA.orgId, SECRET_A);
    const ref = rows[0]!.store_integration_secret;
    expect(ref).toMatch(/^[0-9a-f-]{36}$/);
    await expect(credentialsRefFor(ownerA.orgId)).resolves.toBe(ref);

    // the row in vault.secrets is the encrypted one — the ciphertext is not the plaintext
    const [stored] = await withServiceRole(db, (tx) =>
      tx.execute<{ name: string; secret: string }>(
        sql`select name, secret from vault.secrets where id = ${ref}::uuid`,
      ),
    );
    expect(stored!.name).toBe(`integration:${ownerA.orgId}:${PROVIDER}`);
    expect(stored!.secret).not.toContain("ace-key-A");
  });

  it("rotating one field reuses the vault row and keeps the fields not retyped", async () => {
    const before = await credentialsRefFor(ownerA.orgId);
    // the panel only ever sends the fields the operator filled in
    const rows = await storeAs(ownerA, ownerA.orgId, JSON.stringify({ apiKey: "ace-key-A2" }));
    expect(rows[0]!.store_integration_secret).toBe(before);
    await expect(readSecret(ownerA.orgId)).resolves.toEqual({
      apiKey: "ace-key-A2",
      apiSecret: "ace-secret-A",
    });

    // adding a third field leaves the other two alone
    await storeAs(ownerA, ownerA.orgId, JSON.stringify({ accountId: "acct-A" }));
    await expect(readSecret(ownerA.orgId)).resolves.toEqual({
      apiKey: "ace-key-A2",
      apiSecret: "ace-secret-A",
      accountId: "acct-A",
    });

    // restore the value the remaining tests assert on
    await withRls(db, as(ownerA), (tx) =>
      tx.execute(sql`select public.delete_integration_secret(${ownerA.orgId}::uuid, ${PROVIDER})`),
    );
    await storeAs(ownerA, ownerA.orgId, SECRET_A);
  });

  it("the service role reads the plaintext back", async () => {
    const { data, error } = await admin().rpc("read_integration_secret", {
      p_org: ownerA.orgId,
      p_provider: PROVIDER,
    });
    expect(error).toBeNull();
    expect(data).toBe(SECRET_A);
  });

  it("an authenticated session cannot execute the reader, nor read the vault directly", async () => {
    const viaRpc = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx.execute(sql`select public.read_integration_secret(${ownerA.orgId}::uuid, ${PROVIDER})`),
      ),
    );
    expect(viaRpc).toMatch(/permission denied for function read_integration_secret/i);

    const viaView = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx.execute(sql`select decrypted_secret from vault.decrypted_secrets`),
      ),
    );
    expect(viaView).toMatch(/permission denied/i);

    // and the config row itself never exposes anything but the pointer
    const [cfg] = await withRls(db, as(ownerA), (tx) =>
      tx
        .select()
        .from(integrationConfigs)
        .where(
          and(
            eq(integrationConfigs.organizationId, ownerA.orgId),
            eq(integrationConfigs.provider, PROVIDER),
          ),
        ),
    );
    expect(JSON.stringify(cfg)).not.toContain("ace-key-A");
  });

  it("another tenant's owner can neither write nor reach org A's secret", async () => {
    const cross = await rejection(storeAs(ownerB, ownerA.orgId, "{}"));
    expect(cross).toMatch(/not authorized for organization/i);

    const crossDelete = await rejection(
      withRls(db, as(ownerB), (tx) =>
        tx.execute(
          sql`select public.delete_integration_secret(${ownerA.orgId}::uuid, ${PROVIDER})`,
        ),
      ),
    );
    expect(crossDelete).toMatch(/not authorized for organization/i);

    // org B's own credentials are a separate secret; reading B never yields A's
    await storeAs(ownerB, ownerB.orgId, SECRET_B);
    const client = admin();
    const [a, b] = await Promise.all([
      client.rpc("read_integration_secret", { p_org: ownerA.orgId, p_provider: PROVIDER }),
      client.rpc("read_integration_secret", { p_org: ownerB.orgId, p_provider: PROVIDER }),
    ]);
    expect(a.data).toBe(SECRET_A);
    expect(b.data).toBe(SECRET_B);
  });

  it("a member without integrations.manage cannot store or clear credentials", async () => {
    const store = await rejection(storeAs(readOnlyA, readOnlyA.orgId, "{}"));
    expect(store).toMatch(/not authorized for organization/i);

    const clear = await rejection(
      withRls(db, as(readOnlyA), (tx) =>
        tx.execute(
          sql`select public.delete_integration_secret(${readOnlyA.orgId}::uuid, ${PROVIDER})`,
        ),
      ),
    );
    expect(clear).toMatch(/not authorized for organization/i);

    // the secret survived both attempts
    const { data } = await admin().rpc("read_integration_secret", {
      p_org: ownerA.orgId,
      p_provider: PROVIDER,
    });
    expect(data).toBe(SECRET_A);
  });

  it("clearing removes the vault row and the pointer, and is idempotent", async () => {
    const ref = await credentialsRefFor(ownerA.orgId);
    const [first] = await withRls(db, as(ownerA), (tx) =>
      tx.execute<{ delete_integration_secret: boolean }>(
        sql`select public.delete_integration_secret(${ownerA.orgId}::uuid, ${PROVIDER})`,
      ),
    );
    expect(first!.delete_integration_secret).toBe(true);
    await expect(credentialsRefFor(ownerA.orgId)).resolves.toBeNull();

    const remaining = await withServiceRole(db, (tx) =>
      tx.execute(sql`select 1 from vault.secrets where id = ${ref}::uuid`),
    );
    expect(remaining.length).toBe(0);

    const { data } = await admin().rpc("read_integration_secret", {
      p_org: ownerA.orgId,
      p_provider: PROVIDER,
    });
    expect(data).toBeNull();

    const [second] = await withRls(db, as(ownerA), (tx) =>
      tx.execute<{ delete_integration_secret: boolean }>(
        sql`select public.delete_integration_secret(${ownerA.orgId}::uuid, ${PROVIDER})`,
      ),
    );
    expect(second!.delete_integration_secret).toBe(false);
  });

  it("clear + store replaces wholesale — no field survives the delete", async () => {
    // picks up where the previous test left off: org A has no secret
    await expect(readSecret(ownerA.orgId)).resolves.toBeNull();
    await storeAs(ownerA, ownerA.orgId, JSON.stringify({ accountId: "acct-fresh" }));
    await expect(readSecret(ownerA.orgId)).resolves.toEqual({ accountId: "acct-fresh" });
  });

  it("storing before the provider is configured fails loudly", async () => {
    const missing = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx.execute(
          sql`select public.store_integration_secret(${ownerA.orgId}::uuid, 'hts_tariff', '{}')`,
        ),
      ),
    );
    expect(missing).toMatch(/no integration config/i);
  });

  it("falls back to wholesale replacement when either side is not a JSON object", async () => {
    // the merge is defensive: a secret that predates the JSON contract (or a
    // non-object payload) must not make every later rotation raise.
    await storeAs(ownerA, ownerA.orgId, "legacy-opaque-token");
    const { data: opaque } = await admin().rpc("read_integration_secret", {
      p_org: ownerA.orgId,
      p_provider: PROVIDER,
    });
    expect(opaque).toBe("legacy-opaque-token");

    await storeAs(ownerA, ownerA.orgId, JSON.stringify({ apiKey: "post-migration" }));
    await expect(readSecret(ownerA.orgId)).resolves.toEqual({ apiKey: "post-migration" });
  });
});
