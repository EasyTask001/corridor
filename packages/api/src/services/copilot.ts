/**
 * RAG retrieval + AI SDK tool definitions for the compliance copilot.
 * Retrieval embeds the query and calls the two vector-search RPCs
 * (match_regulations is global; match_org_knowledge is SECURITY DEFINER and
 * checks copilot.use itself). Tools give the model live, tenant-scoped data
 * instead of letting it guess.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { and, desc, eq, ilike, or, schema, sql, type RlsTransaction } from "@corridor/db";
import { lookupHsCode as lookupHsCodeStatic, searchTariff } from "@corridor/integrations";
import {
  MIN_CITATION_SIMILARITY,
  selectEmbedder,
  type OrgKnowledgeMatch,
  type RegulationMatch,
  type RetrievedContext,
} from "@corridor/ai";

const { movements, drivers, movementEvents } = schema;

export async function retrieveContext(
  tx: RlsTransaction,
  orgId: string,
  query: string,
): Promise<RetrievedContext> {
  const embedder = selectEmbedder();
  const { embedding } = await embedder.embed(query);
  const vectorLiteral = `[${embedding.join(",")}]`;

  const [regRows, orgRows] = await Promise.all([
    tx.execute<{
      regulation_document_id: string;
      title: string;
      source: string;
      jurisdiction: "US" | "CA";
      url: string | null;
      chunk_index: number;
      content: string;
      similarity: number;
    }>(sql`select * from public.match_regulations(${vectorLiteral}::vector, 5, null)`),
    tx.execute<{
      id: string;
      source_type: OrgKnowledgeMatch["sourceType"];
      source_id: string | null;
      content: string;
      metadata: Record<string, unknown>;
      similarity: number;
    }>(sql`select * from public.match_org_knowledge(${orgId}::uuid, ${vectorLiteral}::vector, 5)`),
  ]);

  const regulations: RegulationMatch[] = regRows
    .filter((r) => r.similarity >= MIN_CITATION_SIMILARITY)
    .map((r) => ({
      regulationDocumentId: r.regulation_document_id,
      title: r.title,
      source: r.source,
      jurisdiction: r.jurisdiction,
      url: r.url,
      chunkIndex: r.chunk_index,
      content: r.content,
      similarity: r.similarity,
    }));

  const orgKnowledge: OrgKnowledgeMatch[] = orgRows
    .filter((r) => r.similarity >= MIN_CITATION_SIMILARITY)
    .map((r) => ({
      id: r.id,
      sourceType: r.source_type,
      sourceId: r.source_id,
      content: r.content,
      metadata: r.metadata,
      similarity: r.similarity,
    }));

  return { regulations, orgKnowledge };
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
        "Look up a movement (e-manifest) by its movement number (e.g. ACE-26-00001) and return its current status, crossing point, ETA and customs reference.",
      inputSchema: z.object({
        movementNumber: z.string().describe("The movement number, e.g. ACE-26-00001"),
      }),
      execute: async ({ movementNumber }) =>
        rls(async (tx) => {
          const [m] = await tx
            .select({
              id: movements.id,
              movementNumber: movements.movementNumber,
              status: movements.status,
              regime: movements.regime,
              crossingPoint: movements.crossingPoint,
              scheduledCrossingAt: movements.scheduledCrossingAt,
              customsReferenceNumber: movements.customsReferenceNumber,
            })
            .from(movements)
            .where(
              and(
                eq(movements.organizationId, orgId),
                ilike(movements.movementNumber, movementNumber),
              ),
            )
            .limit(1);
          if (!m)
            return { found: false, message: `No movement found matching "${movementNumber}".` };
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
          return { found: true, ...m, lastEvent: lastEvent ?? null };
        }),
    }),

    lookupHsCode: tool({
      description:
        "Look up tariff classification info for an HS code, or search by keyword when the exact code isn't known. Returns description and general duty rates.",
      inputSchema: z.object({
        hsCode: z.string().optional().describe("Exact HS code, e.g. 7208.10"),
        keyword: z.string().optional().describe("Keyword to search when the HS code isn't known"),
      }),
      execute: async ({ hsCode, keyword }) => {
        if (hsCode) {
          const entry = lookupHsCodeStatic(hsCode);
          return entry ?? { found: false, message: `No tariff entry found for HS code ${hsCode}.` };
        }
        if (keyword) {
          const results = searchTariff(keyword);
          return results.length
            ? results
            : { found: false, message: `No tariff entries match "${keyword}".` };
        }
        return { found: false, message: "Provide either an hsCode or a keyword." };
      },
    }),

    checkDriverExpiry: tool({
      description:
        "Check a driver's license, FAST card and medical certificate expiry dates by name.",
      inputSchema: z.object({ driverName: z.string().describe("Driver's first and/or last name") }),
      execute: async ({ driverName }) =>
        rls(async (tx) => {
          const like = `%${driverName.replace(/[%_\\]/g, "\\$&")}%`;
          const rows = await tx
            .select({
              firstName: drivers.firstName,
              lastName: drivers.lastName,
              licenseNumber: drivers.licenseNumber,
              licenseExpiry: drivers.licenseExpiry,
              fastCardNumber: drivers.fastCardNumber,
              fastCardExpiry: drivers.fastCardExpiry,
              medicalCertExpiry: drivers.medicalCertExpiry,
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
