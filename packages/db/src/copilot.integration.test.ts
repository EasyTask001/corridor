/**
 * Phase 6 — Copilot RAG: match_regulations/match_org_knowledge RPCs and RLS.
 * Uses the deterministic mock embedder (no OpenAI key needed) so vectors are
 * self-consistent between the rows this test inserts and the query it runs.
 * Requires local Supabase + `pnpm db:seed`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { mockEmbed, MOCK_DIMENSIONS } from "@corridor/ai";
import { createDb } from "./client";
import { withRls } from "./rls";
import {
  organizationKnowledgeEmbeddings,
  organizationMembers,
  regulationDocuments,
  regulationEmbeddings,
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
  if (!m) throw new Error(`no membership for ${email}`);
  return { userId: user.id, email, orgId: m.orgId };
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
const vectorLiteral = (v: number[]) => `[${v.join(",")}]`;

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

const TEST_SOURCE = "TEST-COPILOT-FIXTURE";

// regulation_documents/regulation_embeddings are only writable by the
// service role (ingestion) — see 0007_copilot.sql — so fixtures go in through
// the raw `db` connection (superuser, bypasses RLS), never `withRls`.
async function seedTestRegulation() {
  const content = "The quick brown fox jumps over the lazy dog at the border crossing.";
  const embedding = mockEmbed(content);
  const [doc] = await db
    .insert(regulationDocuments)
    .values({
      source: TEST_SOURCE,
      title: "Fixture regulation",
      jurisdiction: "US",
      url: null,
      content,
    })
    .returning({ id: regulationDocuments.id });
  await db.insert(regulationEmbeddings).values({
    regulationDocumentId: doc!.id,
    chunkIndex: 0,
    content,
    embedding,
  });
  return doc!.id;
}

afterEach(async () => {
  await db.delete(regulationDocuments).where(eq(regulationDocuments.source, TEST_SOURCE));
  await db.execute(
    sql`delete from public.organization_knowledge_embeddings where content like 'TEST-FIXTURE:%'`,
  );
});

describe("match_regulations", () => {
  it("returns the closest chunk by cosine similarity, regardless of caller's org", async () => {
    await seedTestRegulation();
    const queryEmbedding = mockEmbed("quick brown fox jumps over lazy dog border crossing");
    const rows = await withRls(db, as(ownerB), (tx) =>
      tx.execute<{ source: string; similarity: number }>(
        sql`select * from public.match_regulations(${vectorLiteral(queryEmbedding)}::vector, 5, null)`,
      ),
    );
    const hit = rows.find((r) => r.source === TEST_SOURCE);
    expect(hit).toBeDefined();
    expect(hit!.similarity).toBeGreaterThan(0.5);
  });

  it("filters by jurisdiction when requested", async () => {
    await seedTestRegulation();
    const queryEmbedding = mockEmbed("quick brown fox jumps over lazy dog border crossing");
    const rows = await withRls(db, as(dispatcherA), (tx) =>
      tx.execute<{ source: string; jurisdiction: string }>(
        sql`select * from public.match_regulations(${vectorLiteral(queryEmbedding)}::vector, 20, 'CA')`,
      ),
    );
    expect(rows.every((r) => r.jurisdiction === "CA")).toBe(true);
    expect(rows.find((r) => r.source === TEST_SOURCE)).toBeUndefined();
  });
});

describe("match_org_knowledge", () => {
  async function seedOrgKnowledge(actor: Actor, content: string) {
    const embedding = mockEmbed(content);
    await withRls(db, as(actor), (tx) =>
      tx.insert(organizationKnowledgeEmbeddings).values({
        organizationId: actor.orgId,
        sourceType: "movement_note",
        sourceId: null,
        content,
        embedding,
      }),
    );
  }

  it("returns a member's own org knowledge when they hold copilot.use", async () => {
    const content = "TEST-FIXTURE: held for secondary exam at Ambassador Bridge";
    await seedOrgKnowledge(dispatcherA, content);
    const queryEmbedding = mockEmbed("held for secondary exam at Ambassador Bridge");
    const rows = await withRls(db, as(dispatcherA), (tx) =>
      tx.execute<{ content: string }>(
        sql`select * from public.match_org_knowledge(${dispatcherA.orgId}::uuid, ${vectorLiteral(queryEmbedding)}::vector, 5)`,
      ),
    );
    expect(rows.some((r) => r.content === content)).toBe(true);
  });

  it("rejects a caller who lacks copilot.use in that org", async () => {
    const queryEmbedding = mockEmbed("anything");
    const message = await rejection(
      withRls(db, as(readOnlyA), (tx) =>
        tx.execute(
          sql`select * from public.match_org_knowledge(${readOnlyA.orgId}::uuid, ${vectorLiteral(queryEmbedding)}::vector, 5)`,
        ),
      ),
    );
    expect(message).toMatch(/not authorized/i);
  });

  it("rejects a caller from a different organization (tenant isolation)", async () => {
    const content = "TEST-FIXTURE: org A private note that org B must never see";
    await seedOrgKnowledge(dispatcherA, content);
    const queryEmbedding = mockEmbed(content);
    const message = await rejection(
      withRls(db, as(ownerB), (tx) =>
        tx.execute(
          sql`select * from public.match_org_knowledge(${dispatcherA.orgId}::uuid, ${vectorLiteral(queryEmbedding)}::vector, 5)`,
        ),
      ),
    );
    expect(message).toMatch(/not authorized/i);
  });
});

describe("regulation_embeddings dimension guard", () => {
  it("rejects an embedding of the wrong dimensionality", async () => {
    const wrongSize = new Array(MOCK_DIMENSIONS + 1).fill(0);
    const [doc] = await db
      .insert(regulationDocuments)
      .values({
        source: TEST_SOURCE,
        title: "Bad dims",
        jurisdiction: "US",
        url: null,
        content: "x",
      })
      .returning({ id: regulationDocuments.id });
    const message = await rejection(
      db.execute(sql`
          insert into public.regulation_embeddings (regulation_document_id, chunk_index, content, embedding)
          values (${doc!.id}::uuid, 0, 'x', ${vectorLiteral(wrongSize)}::vector(1536))
        `),
    );
    expect(message).toMatch(/different vector dimensions|expected 1536 dimensions/i);
  });
});
