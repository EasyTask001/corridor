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
  /** Which embedder/model is active, and whether the regulation corpus has been ingested. */
  capabilities: permissionProcedure("copilot.use").query(async ({ ctx }) => {
    const mode = embedderAvailable() ? "model" : "mock";
    const rows = await ctx.rls((tx) =>
      tx.select({ count: sql<number>`count(*)::int` }).from(regulationDocuments),
    );
    return {
      mode,
      regulationsIngested: (rows[0]?.count ?? 0) > 0,
      suggestedQuestions: SUGGESTED_QUESTIONS,
    };
  }),

  regulations: router({
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
