/**
 * Extraction regression and release gate.
 *
 * Regression uses the tracked synthetic fixtures. Pilot/GA gates require a
 * private sanitized corpus supplied outside Git and a configured model:
 *
 *   CORRIDOR_EVAL_GATE=pilot CORRIDOR_EVAL_CORPUS_DIR=/private/path \
 *   CORRIDOR_EVAL_EXTRACTOR=model pnpm --filter @corridor/ai eval
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createModelExtractor } from "../document-intelligence/model-extractor";
import { mockExtractor } from "../document-intelligence/mock-extractor";
import { runExtractionPipeline } from "../document-intelligence/pipeline";
import {
  aggregateExtractionScores,
  extractionGate,
  scoreExtraction,
  type EvalExpected,
  type ExtractionGateName,
  type ExtractionScore,
} from "./scoring";

const here = dirname(fileURLToPath(import.meta.url));
const trackedFixturesDir = join(here, "fixtures");
const corpusDir = process.env.CORRIDOR_EVAL_CORPUS_DIR
  ? resolve(process.env.CORRIDOR_EVAL_CORPUS_DIR)
  : trackedFixturesDir;
const requestedGate = process.env.CORRIDOR_EVAL_GATE ?? "regression";
if (!(["regression", "pilot", "ga"] as string[]).includes(requestedGate)) {
  throw new Error("CORRIDOR_EVAL_GATE must be regression, pilot, or ga");
}
const gateName = requestedGate as ExtractionGateName;
const gate = extractionGate(gateName);
const useModel = process.env.CORRIDOR_EVAL_EXTRACTOR === "model";
const configuredModel = useModel ? createModelExtractor() : null;
const extractor = configuredModel ?? mockExtractor;

function mimeType(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "text/plain";
  }
}

const files = readdirSync(corpusDir);
const fixtures = files
  .filter((filename) => filename.endsWith(".expected.json"))
  .map((expectedFilename) => {
    const name = expectedFilename.slice(0, -".expected.json".length);
    const sourceFilename = files.find(
      (filename) => filename.startsWith(`${name}.`) && !filename.endsWith(".expected.json"),
    );
    if (!sourceFilename) throw new Error(`No source document for ${expectedFilename}`);
    return { name, sourceFilename, expectedFilename };
  });

describe(`extraction eval (${gateName}, ${extractor.name})`, () => {
  const scores: ExtractionScore[] = [];

  for (const fixture of fixtures) {
    it(`${fixture.name} produces a scoreable extraction`, async () => {
      const bytes = new Uint8Array(readFileSync(join(corpusDir, fixture.sourceFilename)));
      const expected = JSON.parse(
        readFileSync(join(corpusDir, fixture.expectedFilename), "utf8"),
      ) as EvalExpected;
      const out = await runExtractionPipeline(
        {
          bytes,
          mimeType: mimeType(fixture.sourceFilename),
          filename: fixture.sourceFilename,
          declaredType: "other",
        },
        { extractor },
      );
      expect(out.ok, out.ok ? "" : `${out.error}; extraction was not scoreable`).toBe(true);
      if (!out.ok) return;
      const score = scoreExtraction(out.document, expected, fixture.name);
      scores.push(score);
      if (gateName === "regression") {
        expect(score.accuracy, `missed fields: ${score.misses.join(", ")}`).toBeGreaterThanOrEqual(
          gate.overallAccuracy,
        );
      }
      if (expected._expectLowConfidence) {
        expect(out.lowConfidenceFields.length).toBeGreaterThan(0);
        expect(out.confidence).toBeLessThan(0.7);
      } else {
        expect(out.confidence).toBeGreaterThanOrEqual(0.7);
      }
    });
  }

  it("meets corpus size, critical-field, and overall accuracy gates", () => {
    if (gateName !== "regression") {
      expect(
        process.env.CORRIDOR_EVAL_CORPUS_DIR,
        "Pilot/GA evaluation requires CORRIDOR_EVAL_CORPUS_DIR outside Git",
      ).toBeTruthy();
      expect(
        configuredModel,
        "Pilot/GA evaluation requires a configured model extractor",
      ).not.toBeNull();
    }
    const report = {
      schemaVersion: 1,
      gate: gateName,
      extractor: extractor.name,
      generatedAt: new Date().toISOString(),
      thresholds: gate,
      ...aggregateExtractionScores(scores),
    };
    console.log(`[eval] ${JSON.stringify(report)}`);
    if (process.env.CORRIDOR_EVAL_REPORT_PATH) {
      const reportPath = resolve(process.env.CORRIDOR_EVAL_REPORT_PATH);
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
    expect(report.documents).toBeGreaterThanOrEqual(gate.minimumDocuments);
    expect(report.critical.accuracy).toBeGreaterThanOrEqual(gate.criticalAccuracy);
    expect(report.overall.accuracy).toBeGreaterThanOrEqual(gate.overallAccuracy);
  });
});
