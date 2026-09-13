import { z } from "zod";
import { desc, eq, schema, sql } from "@corridor/db";
import { embedderAvailable } from "@corridor/ai";
import { permissionProcedure, router } from "../trpc";

const { regulationDocuments } = schema;

export const SUGGESTED_QUESTIONS = [
  "What does our ACE manifest need to include for a truck crossing at Detroit?",
  "Is driver Gurpreet Singh's FAST card still valid?",
  "What HS code covers hot-rolled steel coils, and what's the duty rate?",
  "Why would CBSA hold a shipment even after ACI is transmitted on time?",
  "What's the status of movement ACE-26-00001?",
] as const;

export const copilotRouter = router({
  /**
   * Which embedder/model is active, and whether the regulation corpus has been
   * ingested. Two cheap reads and an env check — no model call, so it stays on
   * the standard tier; spending the caller's much smaller `ai` budget here
   * would let a page load starve the chat route it exists to describe.
   */
  capabilities: permissionProcedure("copilot.use").query(async ({ ctx }) => {
    const mode = embedderAvailable() ? "model" : "mock";
    const rows = await ctx.rls((tx) =>
      tx
        .select({
          status: regulationDocuments.verificationStatus,
          count: sql<number>`count(*)::int`,
        })
        .from(regulationDocuments)
        .groupBy(regulationDocuments.verificationStatus),
    );
    const countOf = (status: string) => rows.find((r) => r.status === status)?.count ?? 0;
    const regulationsVerified = countOf("verified");
    const regulationsDraft = countOf("draft") + countOf("superseded");
    return {
      mode,
      // Only a 'verified' row is ever retrievable (match_regulations, 0052) —
      // this is the count that actually predicts whether a citation can appear.
      regulationsIngested: regulationsVerified > 0,
      regulationsVerified,
      regulationsDraft,
      suggestedQuestions: SUGGESTED_QUESTIONS,
    };
  }),

  regulations: router({
    /** A plain table scan of the ingested corpus — no model call. */
    list: permissionProcedure("copilot.use")
      .input(z.object({ jurisdiction: z.enum(["US", "CA"]).optional() }))
      .query(({ ctx, input }) =>
        ctx.rls((tx) =>
          tx
            .select({
              id: regulationDocuments.id,
              title: regulationDocuments.title,
              source: regulationDocuments.source,
              jurisdiction: regulationDocuments.jurisdiction,
              url: regulationDocuments.url,
              authority: regulationDocuments.authority,
              verificationStatus: regulationDocuments.verificationStatus,
              lastVerifiedAt: regulationDocuments.lastVerifiedAt,
            })
            .from(regulationDocuments)
            .where(
              input.jurisdiction
                ? eq(regulationDocuments.jurisdiction, input.jurisdiction)
                : undefined,
            )
            .orderBy(desc(regulationDocuments.createdAt)),
        ),
      ),
  }),
});
