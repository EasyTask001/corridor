/**
 * Extraction regression gate. Runs the pipeline over fixture documents and
 * scores field-level accuracy against expected JSON. Fails the build when
 * accuracy drops below THRESHOLD — run this when prompts, schemas or the
 * extractor change.
 *
 *   pnpm --filter @corridor/ai eval                 # mock extractor (default in tests)
 *   CORRIDOR_EVAL_EXTRACTOR=model pnpm --filter @corridor/ai eval   # real model (needs AI_GATEWAY_API_KEY or OPENAI_API_KEY)
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createModelExtractor } from "../document-intelligence/model-extractor";
import { mockExtractor } from "../document-intelligence/mock-extractor";
import { runExtractionPipeline } from "../document-intelligence/pipeline";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
const THRESHOLD = 0.9;

const useModel = process.env.CORRIDOR_EVAL_EXTRACTOR === "model";
const extractor = useModel ? (createModelExtractor() ?? mockExtractor) : mockExtractor;

interface Expected {
  documentType?: string;
  documentNumber?: string | null;
  documentDate?: string | null;
  shipper?: { name?: string | null };
  consignee?: { name?: string | null };
  cargo?: Array<Record<string, unknown>>;
  rateConfirmation?: Record<string, unknown>;
  _expectLowConfidence?: boolean;
}

/** Compare leaf values; strings case/space-insensitively, numbers within 1%. */
function same(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "number" && typeof b === "number")
    return Math.abs(a - b) <= Math.abs(b) * 0.01 + 1e-9;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function score(actual: Record<string, unknown>, expected: Expected) {
  let total = 0;
  let hit = 0;
  const misses: string[] = [];
  const check = (path: string, a: unknown, e: unknown) => {
    total++;
    if (same(a, e)) hit++;
    else misses.push(`${path}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`);
  };
  for (const k of ["documentType", "documentNumber", "documentDate"] as const) {
    if (k in expected) check(k, actual[k], expected[k]);
  }
  for (const p of ["shipper", "consignee"] as const) {
    const ep = expected[p];
    if (ep && "name" in ep) check(`${p}.name`, (actual[p] as { name?: unknown })?.name, ep.name);
  }
  const ac = (actual.cargo as Array<Record<string, unknown>>) ?? [];
  for (const [i, el] of (expected.cargo ?? []).entries()) {
    const al = ac[i] ?? {};
    for (const [k, v] of Object.entries(el)) check(`cargo[${i}].${k}`, al[k], v);
  }
  if (expected.cargo) check("cargo.length", ac.length, expected.cargo.length);
  if (expected.rateConfirmation) {
    const arc = (actual.rateConfirmation as Record<string, unknown> | null) ?? {};
    for (const [k, v] of Object.entries(expected.rateConfirmation))
      check(`rateConfirmation.${k}`, arc[k], v);
  }
  return { total, hit, accuracy: total ? hit / total : 1, misses };
}

const fixtures = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".txt"))
  .map((f) => f.replace(/\.txt$/, ""));

describe(`extraction eval (${extractor.name})`, () => {
  const results: Array<{ name: string; accuracy: number }> = [];

  for (const name of fixtures) {
    it(`${name} meets field accuracy ≥ ${THRESHOLD}`, async () => {
      const bytes = new Uint8Array(readFileSync(join(fixturesDir, `${name}.txt`)));
      const expected = JSON.parse(
        readFileSync(join(fixturesDir, `${name}.expected.json`), "utf8"),
      ) as Expected;
      const out = await runExtractionPipeline(
        { bytes, mimeType: "text/plain", filename: `${name}.txt`, declaredType: "other" },
        { extractor },
      );
      expect(out.ok, out.ok ? "" : `${out.error} ${out.issues?.join("; ") ?? ""}`).toBe(true);
      if (!out.ok) return;
      const s = score(out.document as unknown as Record<string, unknown>, expected);
      results.push({ name, accuracy: s.accuracy });
      expect(s.accuracy, s.misses.join("\n")).toBeGreaterThanOrEqual(THRESHOLD);
      if (expected._expectLowConfidence) {
        expect(out.lowConfidenceFields.length).toBeGreaterThan(0);
        expect(out.confidence).toBeLessThan(0.7);
      } else {
        expect(out.confidence).toBeGreaterThanOrEqual(0.7);
      }
    });
  }

  it("reports aggregate accuracy", () => {
    const mean = results.reduce((s, r) => s + r.accuracy, 0) / Math.max(1, results.length);
    console.log(
      `[eval] ${extractor.name}: mean field accuracy ${(mean * 100).toFixed(1)}% over ${results.length} fixtures`,
    );
    expect(mean).toBeGreaterThanOrEqual(THRESHOLD);
  });
});
