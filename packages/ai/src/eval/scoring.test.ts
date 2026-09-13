import { describe, expect, it } from "vitest";
import {
  aggregateExtractionScores,
  extractionGate,
  scoreExtraction,
  type EvalExpected,
} from "./scoring";

describe("extraction release scoring", () => {
  it("reports overall, critical, per-type, and normalized per-field accuracy", () => {
    const expected: EvalExpected = {
      documentType: "bol",
      documentNumber: "BOL-1",
      shipper: { name: "Sender" },
      consignee: { name: "Receiver" },
      cargo: [{ commodityDescription: "Steel", weightKg: 100, pieceCount: 4, hsCode: "7208" }],
    };
    const score = scoreExtraction(
      {
        documentType: "bol",
        documentNumber: "wrong",
        shipper: { name: "Sender" },
        consignee: { name: "Receiver" },
        cargo: [{ commodityDescription: "Steel", weightKg: 100, pieceCount: 4, hsCode: "7208" }],
      },
      expected,
      "sample",
    );
    const report = aggregateExtractionScores([score]);

    expect(score.misses).toEqual(["documentNumber"]);
    expect(JSON.stringify(score)).not.toContain("BOL-1");
    expect(report.documentTypes.bol!.total).toBe(score.total);
    expect(report.fields["cargo[].weightKg"]).toEqual({
      hit: 1,
      total: 1,
      accuracy: 1,
      critical: true,
    });
    expect(report.critical.accuracy).toBeLessThan(1);
  });

  it("enforces 50-document pilot and 250-document GA corpus gates", () => {
    expect(extractionGate("regression")).toMatchObject({ minimumDocuments: 1 });
    expect(extractionGate("pilot")).toMatchObject({
      minimumDocuments: 50,
      criticalAccuracy: 0.95,
      overallAccuracy: 0.9,
    });
    expect(extractionGate("ga")).toMatchObject({ minimumDocuments: 250 });
  });
});
