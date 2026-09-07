import { describe, expect, it } from "vitest";
import { HOLD_LIKELY_THRESHOLD, predictHold } from "./hold-prediction";

const none = {
  rejectedRecently: false,
  weightOutlier: false,
  valueOutlier: false,
  missingBroker: false,
  hsMismatch: false,
};

describe("predictHold", () => {
  it("scores zero with no risk factors", () => {
    const r = predictHold(none);
    expect(r.score).toBe(0);
    expect(r.likely).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("scores 1.0 (capped) when every factor is present", () => {
    const r = predictHold({
      rejectedRecently: true,
      weightOutlier: true,
      valueOutlier: true,
      missingBroker: true,
      hsMismatch: true,
    });
    expect(r.score).toBe(1);
    expect(r.likely).toBe(true);
    expect(r.reasons).toHaveLength(5);
  });

  it("is explainable: every present factor appears in reasons with its own label", () => {
    const r = predictHold({ ...none, hsMismatch: true, valueOutlier: true });
    expect(r.reasons).toEqual([
      "Declared value is a statistical outlier for this lane",
      "Declared HS code does not match the commodity description",
    ]);
    expect(r.factors.find((f) => f.key === "rejectedRecently")!.present).toBe(false);
  });

  it("a single factor alone stays under the likely threshold", () => {
    const r = predictHold({ ...none, rejectedRecently: true });
    // rejectedRecently weight 0.35 / maxPossible 1.2 ≈ 0.29 — well under threshold.
    expect(r.score).toBeLessThan(HOLD_LIKELY_THRESHOLD);
    expect(r.likely).toBe(false);
  });

  it("two mid-weight factors together cross the likely threshold", () => {
    const r = predictHold({ ...none, rejectedRecently: true, weightOutlier: true });
    expect(r.score).toBeGreaterThanOrEqual(HOLD_LIKELY_THRESHOLD);
    expect(r.likely).toBe(true);
  });
});
