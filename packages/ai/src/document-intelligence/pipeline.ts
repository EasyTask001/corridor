/**
 * classify → extract → validate against the domain contract → score.
 *
 * The extractor is chosen per call: `.mock.` filenames and missing keys use
 * the deterministic mock; otherwise the model. Output is ALWAYS validated
 * with `extractedDocument` — a malformed model response is a failure the
 * reviewer sees, never a silently-accepted cargo row.
 */
import { LOW_CONFIDENCE_THRESHOLD, extractedDocument, type DocumentType } from "@corridor/domain";
import { classifyByHints } from "./classify";
import { mockExtractor } from "./mock-extractor";
import { createModelExtractor } from "./model-extractor";
import type { DocumentInput, Extractor, PipelineOutcome } from "./types";

export interface PipelineOptions {
  /** force a specific extractor (tests, ops) */
  extractor?: Extractor;
  env?: NodeJS.ProcessEnv;
}

export function selectExtractor(input: DocumentInput, opts: PipelineOptions = {}): Extractor {
  if (opts.extractor) return opts.extractor;
  const env = opts.env ?? process.env;
  if (env.CORRIDOR_EXTRACTOR === "mock") return mockExtractor;
  if (/\.mock\./i.test(input.filename)) return mockExtractor;
  return createModelExtractor(env) ?? mockExtractor;
}

/** Required-for-manifest fields and their confidences. */
export function lowConfidenceFields(doc: {
  shipper: { confidence: number };
  consignee: { confidence: number };
  cargo: Array<{ confidence: number; weightKg: number | null; pieceCount: number | null }>;
}): string[] {
  const out: string[] = [];
  if (doc.shipper.confidence < LOW_CONFIDENCE_THRESHOLD) out.push("shipper");
  if (doc.consignee.confidence < LOW_CONFIDENCE_THRESHOLD) out.push("consignee");
  doc.cargo.forEach((l, i) => {
    if (l.confidence < LOW_CONFIDENCE_THRESHOLD) out.push(`cargo[${i}]`);
    if (l.weightKg == null) out.push(`cargo[${i}].weightKg`);
    if (l.pieceCount == null) out.push(`cargo[${i}].pieceCount`);
  });
  if (doc.cargo.length === 0) out.push("cargo");
  return out;
}

export async function runExtractionPipeline(
  input: DocumentInput,
  opts: PipelineOptions = {},
): Promise<PipelineOutcome> {
  const extractor = selectExtractor(input, opts);
  const hinted: DocumentType = classifyByHints(input.filename, input.declaredType);

  let raw: unknown;
  let model = extractor.name;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  try {
    const r = await extractor.extract(input, { documentType: hinted });
    raw = r.raw;
    model = r.model;
    usage = r.usage;
  } catch (e) {
    return { ok: false, model, error: e instanceof Error ? e.message : String(e) };
  }

  const parsed = extractedDocument.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      model,
      error: "Extractor output failed domain validation",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }

  const doc = parsed.data;
  const low = lowConfidenceFields(doc);
  // Overall confidence = min over required parts (never trust a self-reported score higher than its parts).
  const parts = [
    doc.shipper.confidence,
    doc.consignee.confidence,
    ...doc.cargo.map((c) => c.confidence),
  ];
  const confidence = Math.min(doc.confidence, ...(parts.length ? parts : [0]));
  const detectedType = doc.documentType !== "other" ? doc.documentType : hinted;

  return {
    ok: true,
    document: { ...doc, documentType: detectedType, confidence },
    detectedType,
    model,
    confidence,
    lowConfidenceFields: low,
    usage,
  };
}
