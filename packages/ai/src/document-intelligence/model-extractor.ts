/**
 * Model-backed extractor on the Vercel AI SDK. Uses `generateObject` with the
 * SAME Zod contract (`extractedDocument`) that validates the review form, so
 * the model is constrained to the domain shape at generation time.
 *
 * Provider: OpenAI via @ai-sdk/openai when OPENAI_API_KEY is set. Swapping to
 * AI Gateway later is a one-line change in `resolveModel`.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { extractedDocument, type DocumentType } from "@corridor/domain";
import type { DocumentInput, Extractor, ExtractorResult } from "./types";

export const DEFAULT_EXTRACTION_MODEL = "gpt-4.1-mini";

const SYSTEM = `You are a customs documentation specialist for cross-border trucking between Canada and the United States.
Extract the shipment data from the attached document exactly as written. Rules:
- Never invent values. If a field is absent or unreadable, return null and lower the confidence.
- HS codes must be 4–10 digits in dotted form (e.g. 7208.10). If the document shows an HTS/tariff number, normalise it.
- Weights in kilograms (convert lb → kg, 1 lb = 0.45359237 kg, and mention the conversion in notes).
- Currency codes USD or CAD only.
- Country of origin as ISO 3166-1 alpha-2.
- One cargo line per distinct commodity line on the document.
- confidence is 0..1 for each party and line; overall confidence is the minimum of the parts that a customs manifest requires (shipper, consignee, each line's description/weight/pieces).
- Put anything ambiguous in notes for the human reviewer.`;

function resolveModel(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const openai = createOpenAI({ apiKey });
  const id = env.CORRIDOR_EXTRACTION_MODEL ?? DEFAULT_EXTRACTION_MODEL;
  return { model: openai(id), id };
}

export function modelExtractorAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.OPENAI_API_KEY;
}

export function createModelExtractor(env: NodeJS.ProcessEnv = process.env): Extractor | null {
  const resolved = resolveModel(env);
  if (!resolved) return null;
  const { model, id } = resolved;

  return {
    name: `openai:${id}`,
    async extract(
      input: DocumentInput,
      hint: { documentType: DocumentType },
    ): Promise<ExtractorResult> {
      const isText = input.mimeType.startsWith("text/") || input.mimeType === "application/json";
      const userContent = isText
        ? [
            {
              type: "text" as const,
              text: `Declared document type: ${hint.documentType}. Filename: ${input.filename}.\n\n--- DOCUMENT ---\n${new TextDecoder().decode(input.bytes)}`,
            },
          ]
        : [
            {
              type: "text" as const,
              text: `Declared document type: ${hint.documentType}. Filename: ${input.filename}. Extract the shipment data from the attached file.`,
            },
            { type: "file" as const, data: input.bytes, mediaType: input.mimeType },
          ];

      const result = await generateObject({
        model,
        schema: extractedDocument,
        system: SYSTEM,
        messages: [{ role: "user", content: userContent }],
        temperature: 0,
      });

      return {
        raw: result.object,
        model: id,
        usage: { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens },
      };
    },
  };
}
