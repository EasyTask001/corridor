/**
 * Model-backed extractor on the Vercel AI SDK. Uses `generateObject` with the
 * SAME Zod contract (`extractedDocument`) that validates the review form, so
 * the model is constrained to the domain shape at generation time.
 *
 * Provider selection lives in `../client` (Vercel AI Gateway → Claude when
 * AI_GATEWAY_API_KEY is set, OpenAI direct when only OPENAI_API_KEY is, and
 * nothing at all otherwise — the pipeline then uses the mock extractor).
 */
import { generateObject } from "ai";
import { extractedDocument, type DocumentType } from "@corridor/domain";
import { aiConfigured, languageModel } from "../client";
import type { DocumentInput, Extractor, ExtractorResult } from "./types";

const SYSTEM = `You are a customs documentation specialist for cross-border trucking between Canada and the United States.
Extract the shipment data from the attached document exactly as written. Rules:
- Never invent values. If a field is absent or unreadable, return null and lower the confidence.
- HS codes must be 4–10 digits in dotted form (e.g. 7208.10). If the document shows an HTS/tariff number, normalise it.
- Weights in kilograms (convert lb → kg, 1 lb = 0.45359237 kg, and mention the conversion in notes).
- Currency codes USD or CAD only.
- Country of origin as ISO 3166-1 alpha-2.
- One cargo line per distinct commodity line on the document.
- confidence is 0..1 for each party and line; overall confidence is the minimum of the parts that a customs manifest requires (shipper, consignee, each line's description/weight/pieces).
- Put anything ambiguous in notes for the human reviewer.

Rate confirmations (broker → carrier load tenders, often headed "RATE CONFIRMATION" or "CARRIER RATE
CONFIRMATION") are NOT customs documents: they carry no commodity detail. For those, set
documentType to "rate_confirmation", return an EMPTY cargo array (never invent commodity lines from
a load tender), and fill the rateConfirmation object instead:
- carrierName / brokerName exactly as printed; referenceNumber is the load / pro / confirmation number.
- rateAmount is the total linehaul rate agreed with the carrier, rateCurrency USD or CAD.
- pickupAt / deliveryAt as ISO-8601 date-times in the document's own local time; date-only when no
  time is given (append T00:00:00).
- equipment is the trailer type as printed (e.g. "53' reefer", "dry van").
- rateConfirmation.confidence is 0..1 over those fields, and is the overall document confidence.
For any other document type, leave rateConfirmation null.`;

export function modelExtractorAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return aiConfigured(env);
}

export function createModelExtractor(env: NodeJS.ProcessEnv = process.env): Extractor | null {
  const resolved = languageModel("extraction", env);
  if (!resolved) return null;
  const { model, id, label } = resolved;

  return {
    name: label,
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
