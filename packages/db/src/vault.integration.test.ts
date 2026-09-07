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
const SECRET_A = JSON.stringify({ apiKey: "ace-key-A", apiSecret: "ace-secret-A" });
const SECRET_B = JSON.stringify({ apiKey: "aci-key-B" });

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
});

afterAll(async () => {
  // Leave no plaintext behind, even on failure.
  const client = admin();
  await client.rpc("delete_integration_secret", { p_org: ownerA.orgId, p_provider: PROVIDER });
  await client.rpc("delete_integration_secret", { p_org: ownerB.orgId, p_provider: PROVIDER });
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

  it("rotating reuses the same vault row rather than accumulating secrets", async () => {
    const before = await credentialsRefFor(ownerA.orgId);
    const rotated = JSON.stringify({ apiKey: "ace-key-A2" });
    const rows = await storeAs(ownerA, ownerA.orgId, rotated);
    expect(rows[0]!.store_integration_secret).toBe(before);

    const { data } = await admin().rpc("read_integration_secret", {
      p_org: ownerA.orgId,
      p_provider: PROVIDER,
    });
    expect(data).toBe(rotated);

    // restore the value the remaining tests assert on
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
});
