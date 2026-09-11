/**
 * classify → extract → validate against the domain contract → score.
 *
 * The extractor is chosen per call: `.mock.` filenames and missing keys use
 * the deterministic mock; otherwise the model. Output is ALWAYS validated
 * with `extractedDocument` — a malformed model response is a failure the
 * reviewer sees, never a silently-accepted cargo row.
 */
import {
  LOW_CONFIDENCE_THRESHOLD,
  extractedDocument,
  roundToCents,
  type DocumentType,
} from "@corridor/domain";
import { classifyByHints } from "./classify";
import { mockExtractor } from "./mock-extractor";
import { createModelExtractor } from "./model-extractor";
import { CLASSIFIER_TEXT_BYTES, readableText } from "./text";
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

/**
 * The model is told to return money but may emit 3+ decimal places; round
 * `cargo[].valueAmount`, `totals.valueAmount` and `rateConfirmation.rateAmount`
 * to cents before the domain schema validates the raw output, so the review
 * form never sees a sub-cent value.
 */
function roundMoneyFields(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const doc = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...doc };

  if (Array.isArray(doc.cargo)) {
    out.cargo = doc.cargo.map((line) => {
      if (line === null || typeof line !== "object") return line;
      const l = line as Record<string, unknown>;
      return typeof l.valueAmount === "number"
        ? { ...l, valueAmount: roundToCents(l.valueAmount) }
        : l;
    });
  }

  if (doc.totals !== null && typeof doc.totals === "object") {
    const totals = doc.totals as Record<string, unknown>;
    if (typeof totals.valueAmount === "number") {
      out.totals = { ...totals, valueAmount: roundToCents(totals.valueAmount) };
    }
  }

  if (doc.rateConfirmation !== null && typeof doc.rateConfirmation === "object") {
    const rc = doc.rateConfirmation as Record<string, unknown>;
    if (typeof rc.rateAmount === "number") {
      out.rateConfirmation = { ...rc, rateAmount: roundToCents(rc.rateAmount) };
    }
  }

  return out;
}

/**
 * Required-for-manifest fields and their confidences. A rate confirmation is a
 * load tender, not a customs document: it is not expected to carry cargo lines,
 * so only its own block is scored.
 */
export function lowConfidenceFields(
  doc: {
    shipper: { confidence: number };
    consignee: { confidence: number };
    cargo: Array<{ confidence: number; weightKg: number | null; pieceCount: number | null }>;
    rateConfirmation?: { confidence: number } | null;
  },
  documentType?: DocumentType,
): string[] {
  const out: string[] = [];
  if (documentType === "rate_confirmation") {
    if ((doc.rateConfirmation?.confidence ?? 0) < LOW_CONFIDENCE_THRESHOLD)
      out.push("rateConfirmation");
    return out;
  }
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
  const hinted: DocumentType = classifyByHints(
    input.filename,
    input.declaredType,
    readableText(input, CLASSIFIER_TEXT_BYTES),
  );

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

  const parsed = extractedDocument.safeParse(roundMoneyFields(raw));
  if (!parsed.success) {
    return {
      ok: false,
      model,
      error: "Extractor output failed domain validation",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }

  const doc = parsed.data;
  const detectedType = doc.documentType !== "other" ? doc.documentType : hinted;
  const low = lowConfidenceFields(doc, detectedType);
  // Overall confidence = min over required parts (never trust a self-reported
  // score higher than its parts). A rate confirmation has no manifest parts —
  // its own block carries the confidence.
  const parts =
    detectedType === "rate_confirmation"
      ? [doc.rateConfirmation?.confidence ?? 0]
      : [doc.shipper.confidence, doc.consignee.confidence, ...doc.cargo.map((c) => c.confidence)];
  const confidence = Math.min(doc.confidence, ...(parts.length ? parts : [0]));

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
