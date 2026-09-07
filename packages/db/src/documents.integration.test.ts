/**
 * Phase 4 integration: source_documents RLS + Storage object policies.
 * Requires local Supabase + `pnpm db:seed`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { createDb } from "./client";
import { withRls, withServiceRole } from "./rls";
import { organizationMembers, sourceDocuments } from "./schema";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
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

async function userClient(email: string) {
  if (!ANON_KEY) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY required");
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: "corridor-demo" });
  if (error) throw error;
  return c;
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
    const m: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = e.cause) m.push(e.message);
    return m.join(" | ");
  }
  throw new Error("expected rejection");
}

describe("source_documents RLS", () => {
  it("uploader can insert; read-only can read but not insert; other org sees nothing", async () => {
    const path = `${dispatcherA.orgId}/${crypto.randomUUID()}/test.txt`;
    const [doc] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(sourceDocuments)
        .values({
          organizationId: dispatcherA.orgId,
          storagePath: path,
          originalFilename: "test.txt",
          mimeType: "text/plain",
          uploadedBy: dispatcherA.userId,
        })
        .returning({ id: sourceDocuments.id }),
    );
    const ro = await withRls(db, as(readOnlyA), (tx) =>
      tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, doc!.id)),
    );
    expect(ro).toHaveLength(1);
    const denied = await rejection(
      withRls(db, as(readOnlyA), (tx) =>
        tx
          .insert(sourceDocuments)
          .values({
            organizationId: readOnlyA.orgId,
            storagePath: `${readOnlyA.orgId}/x/y.txt`,
            originalFilename: "y",
            mimeType: "text/plain",
          })
          .returning(),
      ),
    );
    expect(denied).toMatch(/row-level security/);
    const other = await withRls(db, as(ownerB), (tx) =>
      tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, doc!.id)),
    );
    expect(other).toHaveLength(0);
    await withServiceRole(db, (tx) =>
      tx.delete(sourceDocuments).where(eq(sourceDocuments.id, doc!.id)),
    );
  });
});

describe("storage object policies", () => {
  it("dispatcher can upload into their org folder; read-only cannot; cross-org folder is rejected", async () => {
    const dispatcher = await userClient("dispatch@pathfinder.demo");
    const own = `${dispatcherA.orgId}/${crypto.randomUUID()}/policy-test.txt`;
    const up = await dispatcher.storage
      .from("documents")
      .upload(own, new Blob(["hello"], { type: "text/plain" }), { contentType: "text/plain" });
    expect(up.error).toBeNull();

    const foreign = `${ownerB.orgId}/${crypto.randomUUID()}/sneaky.txt`;
    const bad = await dispatcher.storage
      .from("documents")
      .upload(foreign, new Blob(["x"], { type: "text/plain" }), { contentType: "text/plain" });
    expect(bad.error?.message).toMatch(/row-level security|policy|Unauthorized|not allowed/i);

    const readOnly = await userClient("readonly@pathfinder.demo");
    const roUp = await readOnly.storage
      .from("documents")
      .upload(
        `${readOnlyA.orgId}/${crypto.randomUUID()}/ro.txt`,
        new Blob(["x"], { type: "text/plain" }),
        { contentType: "text/plain" },
      );
    expect(roUp.error).not.toBeNull();
    // …but read-only can download within the org (document.read)
    const dl = await readOnly.storage.from("documents").download(own);
    expect(dl.error).toBeNull();

    const nora = await userClient("owner@northbound.demo");
    const cross = await nora.storage.from("documents").download(own);
    expect(cross.error).not.toBeNull();

    await dispatcher.storage.from("documents").remove([own]);
  });
});
