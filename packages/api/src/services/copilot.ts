/**
 * RAG retrieval + AI SDK tool definitions for the compliance copilot.
 * Retrieval embeds the query and calls the two vector-search RPCs
 * (match_regulations is global; match_org_knowledge is SECURITY DEFINER and
 * checks copilot.use itself). Tools give the model live, tenant-scoped data
 * instead of letting it guess.
 */
import { createHash } from "node:crypto";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { and, desc, eq, ilike, or, schema, sql, type RlsTransaction } from "@corridor/db";
import { containsPattern, escapeLike } from "../infra/like";
import {
  lookupHsCode as lookupHsCodeStatic,
  searchTariff,
  type TariffEntry,
} from "@corridor/integrations";
import {
  minCitationSimilarity,
  selectEmbedder,
  type OrgKnowledgeMatch,
  type RegulationMatch,
  type RetrievedContext,
} from "@corridor/ai";
import { getKv } from "../infra/redis";

const { movements, drivers, movementEvents, ports } = schema;

/**
 * Retrieval caching. The regulation corpus is global and changes only when it
 * is re-ingested, so its matches keep for 10 minutes. Org knowledge is tenant
 * data — its key carries the org id (never shared across tenants) and a version
 * counter bumped whenever a `copilot.embed_knowledge` job adds to the corpus.
 */
const REGULATION_CACHE_TTL_SECONDS = 600;
const ORG_KNOWLEDGE_CACHE_TTL_SECONDS = 60;

/** Whitespace/case-insensitive, so trivially different phrasings share a key. */
function normaliseQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Bounded, stable key suffix for an arbitrarily long question. SHA-256 rather
 * than a cheap 32-bit hash: a collision here would answer one question with
 * another question's citations.
 */
function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function orgKnowledgeVersionKey(orgId: string): string {
  return `copilot:kb:${orgId}:version`;
}

/** Bumped when org knowledge is added, which retires every cached org result. */
export async function invalidateOrgKnowledgeCache(orgId: string): Promise<void> {
  try {
    await getKv().incr(orgKnowledgeVersionKey(orgId));
  } catch (error) {
    console.error("[copilot] knowledge cache invalidation failed", error);
  }
}

async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    return await getKv().get<T>(key);
  } catch (error) {
    console.error("[copilot] retrieval cache read failed", error);
    return null;
  }
}

async function cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  try {
    await getKv().set(key, value, ttlSeconds);
  } catch (error) {
    console.error("[copilot] retrieval cache write failed", error);
  }
}

export async function retrieveContext(
  tx: RlsTransaction,
  orgId: string,
  query: string,
  opts: { jurisdiction?: "US" | "CA" | null } = {},
): Promise<RetrievedContext> {
  const jurisdiction = opts.jurisdiction ?? null;
  const queryKey = fingerprint(normaliseQuery(query));
  const regulationKey = `copilot:reg:${jurisdiction ?? "all"}:${queryKey}`;
  const version = (await cacheGet<number>(orgKnowledgeVersionKey(orgId))) ?? 0;
  const orgKey = `copilot:org:${orgId}:${version}:${queryKey}`;

  const [cachedRegulations, cachedOrgKnowledge] = await Promise.all([
    cacheGet<RegulationMatch[]>(regulationKey),
    cacheGet<OrgKnowledgeMatch[]>(orgKey),
  ]);
  if (cachedRegulations && cachedOrgKnowledge) {
    return { regulations: cachedRegulations, orgKnowledge: cachedOrgKnowledge };
  }

  // The raw query is embedded (normalisation only affects the cache key).
  const embedder = selectEmbedder();
  const { embedding } = await embedder.embed(query);
  const vectorLiteral = `[${embedding.join(",")}]`;
  // The corpus was embedded by whichever embedder is configured now, so the
  // citation gate follows the same one (the mock's cosine scale is lower).
  const minSimilarity = minCitationSimilarity(embedder.name);

  const [regulations, orgKnowledge] = await Promise.all([
    cachedRegulations ??
      matchRegulations(tx, vectorLiteral, jurisdiction, minSimilarity, embedder.name),
    cachedOrgKnowledge ?? matchOrgKnowledge(tx, orgId, vectorLiteral, minSimilarity),
  ]);

  await Promise.all([
    cachedRegulations
      ? undefined
      : cacheSet(regulationKey, regulations, REGULATION_CACHE_TTL_SECONDS),
    cachedOrgKnowledge
      ? undefined
      : cacheSet(orgKey, orgKnowledge, ORG_KNOWLEDGE_CACHE_TTL_SECONDS),
  ]);

  return { regulations, orgKnowledge };
}

async function matchRegulations(
  tx: RlsTransaction,
  vectorLiteral: string,
  jurisdiction: "US" | "CA" | null,
  minSimilarity: number,
  embedderName: string,
): Promise<RegulationMatch[]> {
  const rows = await tx.execute<{
    regulation_document_id: string;
    title: string;
    source: string;
    jurisdiction: "US" | "CA";
    url: string | null;
    chunk_index: number;
    content: string;
    similarity: number;
    authority: string | null;
    // A raw tx.execute() row does not consistently deserialize timestamptz to
    // a Date the way a typed Drizzle select does — handle whichever the
    // driver hands back.
    last_verified_at: Date | string | null;
  }>(
    // The 4th argument keeps a mock-embedded corpus and a real-model query (or
    // vice versa) from ever being compared — the vectors are not comparable,
    // and mixing them silently produces a meaningless similarity score
    // instead of an error.
    sql`select * from public.match_regulations(${vectorLiteral}::vector, 5, ${jurisdiction}::text, ${embedderName}::text)`,
  );

  return rows
    .filter((r) => r.similarity >= minSimilarity)
    .map((r) => ({
      regulationDocumentId: r.regulation_document_id,
      title: r.title,
      source: r.source,
      jurisdiction: r.jurisdiction,
      url: r.url,
      chunkIndex: r.chunk_index,
      content: r.content,
      similarity: r.similarity,
      authority: r.authority,
      lastVerifiedAt: r.last_verified_at
        ? new Date(r.last_verified_at).toISOString().slice(0, 10)
        : null,
    }));
}

async function matchOrgKnowledge(
  tx: RlsTransaction,
  orgId: string,
  vectorLiteral: string,
  minSimilarity: number,
): Promise<OrgKnowledgeMatch[]> {
  const rows = await tx.execute<{
    id: string;
    source_type: OrgKnowledgeMatch["sourceType"];
    source_id: string | null;
    content: string;
    metadata: Record<string, unknown>;
    similarity: number;
  }>(sql`select * from public.match_org_knowledge(${orgId}::uuid, ${vectorLiteral}::vector, 5)`);

  return rows
    .filter((r) => r.similarity >= minSimilarity)
    .map((r) => ({
      id: r.id,
      sourceType: r.source_type,
      sourceId: r.source_id,
      content: r.content,
      metadata: r.metadata,
      similarity: r.similarity,
    }));
}

/** Embed and store one piece of organization knowledge (e.g. a movement note). */
export async function embedOrgKnowledge(
  tx: RlsTransaction,
  orgId: string,
  input: {
    sourceType: "movement_note" | "hold_resolution" | "sop_document";
    sourceId: string | null;
    content: string;
  },
) {
  const embedder = selectEmbedder();
  const { embedding } = await embedder.embed(input.content);
  const vectorLiteral = `[${embedding.join(",")}]`;
  await tx.execute(sql`
    insert into public.organization_knowledge_embeddings (organization_id, source_type, source_id, content, embedding)
    values (${orgId}::uuid, ${input.sourceType}, ${input.sourceId}, ${input.content}, ${vectorLiteral}::vector)
  `);
}

// ---------------------------------------------------------------------------
// Tools — each opens its OWN short-lived RLS transaction via the caller's
// `ctx.rls`, rather than sharing one held open for the whole streaming
// response (a chat request can run for tens of seconds; a single long-lived
// transaction for its duration would tie up a pooled connection needlessly).
// ---------------------------------------------------------------------------

export type RlsRunner = <T>(fn: (tx: RlsTransaction) => Promise<T>) => Promise<T>;

export function copilotTools(rls: RlsRunner, orgId: string): ToolSet {
  return {
    lookupMovementStatus: tool({
      description:
        "Look up a movement (e-manifest) by its movement number (e.g. ACE-26-00001) and return its current status, port of entry, ETA and customs reference.",
      inputSchema: z.object({
        movementNumber: z.string().describe("The movement number, e.g. ACE-26-00001"),
      }),
      execute: async ({ movementNumber }) =>
        rls(async (tx) => {
          const [raw] = await tx
            .select({
              id: movements.id,
              movementNumber: movements.movementNumber,
              status: movements.status,
              regime: movements.regime,
              portCode: ports.code,
              portName: ports.name,
              carrierCode: movements.carrierCode,
              scheduledCrossingAt: movements.scheduledCrossingAt,
              customsReferenceNumber: movements.customsReferenceNumber,
            })
            .from(movements)
            .leftJoin(ports, eq(ports.id, movements.portId))
            .where(
              and(
                eq(movements.organizationId, orgId),
                ilike(movements.movementNumber, escapeLike(movementNumber)),
              ),
            )
            .limit(1);
          if (!raw)
            return { found: false, message: `No movement found matching "${movementNumber}".` };
          const { portCode, portName, ...m } = raw;
          const port = portCode ? { code: portCode, name: portName! } : null;
          const [lastEvent] = await tx
            .select({
              eventType: movementEvents.eventType,
              payload: movementEvents.payload,
              occurredAt: movementEvents.occurredAt,
            })
            .from(movementEvents)
            .where(eq(movementEvents.movementId, m.id))
            .orderBy(desc(movementEvents.occurredAt))
            .limit(1);
          return { found: true, ...m, port, lastEvent: lastEvent ?? null };
        }),
    }),

    lookupHsCode: tool({
      description:
        "Search Corridor's synthetic tariff demo. Results are experimental, not live, and cannot be used as compliance evidence.",
      inputSchema: z.object({
        hsCode: z.string().optional().describe("Exact HS code, e.g. 7208.10"),
        keyword: z.string().optional().describe("Keyword to search when the HS code isn't known"),
      }),
      execute: ({
        hsCode,
        keyword,
      }): Promise<TariffEntry | TariffEntry[] | { found: false; message: string }> => {
        if (hsCode) {
          const entry = lookupHsCodeStatic(hsCode);
          return Promise.resolve(
            entry ?? { found: false, message: `No tariff entry found for HS code ${hsCode}.` },
          );
        }
        if (keyword) {
          const results = searchTariff(keyword);
          return Promise.resolve(
            results.length
              ? results
              : { found: false, message: `No tariff entries match "${keyword}".` },
          );
        }
        return Promise.resolve({ found: false, message: "Provide either an hsCode or a keyword." });
      },
    }),

    checkDriverExpiry: tool({
      description:
        "Check a driver's license, travel documents (FAST/NEXUS/passport) and medical certificate expiry dates by name.",
      inputSchema: z.object({ driverName: z.string().describe("Driver's first and/or last name") }),
      execute: async ({ driverName }) =>
        rls(async (tx) => {
          const like = containsPattern(driverName);
          const rows = await tx
            .select({
              firstName: drivers.firstName,
              lastName: drivers.lastName,
              licenseNumber: drivers.licenseNumber,
              licenseExpiry: drivers.licenseExpiry,
              medicalCertExpiry: drivers.medicalCertExpiry,
              travelDocuments: sql<
                { type: string; number: string; expiresOn: string | null }[]
              >`coalesce((select jsonb_agg(jsonb_build_object('type', dd.document_type,
                                                             'number', dd.document_number,
                                                             'expiresOn', dd.expires_on))
                          from public.driver_documents dd where dd.driver_id = ${drivers.id}), '[]'::jsonb)`,
              status: drivers.status,
            })
            .from(drivers)
            .where(
              and(
                eq(drivers.organizationId, orgId),
                or(ilike(drivers.firstName, like), ilike(drivers.lastName, like)),
              ),
            )
            .limit(5);
          if (rows.length === 0)
            return { found: false, message: `No driver found matching "${driverName}".` };
          return { found: true, drivers: rows };
        }),
    }),
  };
}
