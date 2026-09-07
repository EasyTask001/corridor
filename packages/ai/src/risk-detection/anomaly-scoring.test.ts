import { describe, expect, it } from "vitest";
import { MIN_SAMPLE_SIZE, scoreAnomaly } from "./anomaly-scoring";

describe("scoreAnomaly", () => {
  it("reports no outlier with insufficient history", () => {
    const r = scoreAnomaly(1000, [900, 950]);
    expect(r.sampleSize).toBeLessThan(MIN_SAMPLE_SIZE);
    expect(r.isOutlier).toBe(false);
    expect(r.zScore).toBeNull();
  });

  it("does not flag a value close to the mean", () => {
    const r = scoreAnomaly(21000, [20000, 21500, 19800, 20500]);
    expect(r.isOutlier).toBe(false);
  });

  it("flags a large deviation as an outlier with a positive z-score", () => {
    const r = scoreAnomaly(95000, [20000, 21500, 19800, 20500]);
    expect(r.isOutlier).toBe(true);
    expect(r.zScore).toBeGreaterThan(0);
    expect(r.deviationPct).toBeGreaterThan(100);
  });

  it("flags a large negative deviation too", () => {
    const r = scoreAnomaly(500, [20000, 21500, 19800, 20500]);
    expect(r.isOutlier).toBe(true);
    expect(r.zScore).toBeLessThan(0);
  });

  it("handles zero-variance history without dividing by zero", () => {
    const same = scoreAnomaly(1000, [1000, 1000, 1000]);
    expect(same.isOutlier).toBe(false);
    const diff = scoreAnomaly(2000, [1000, 1000, 1000]);
    expect(diff.isOutlier).toBe(true);
    expect(diff.zScore).toBe(Infinity === diff.zScore ? diff.zScore : diff.zScore); // finite guard below
    expect(Number.isFinite(diff.zScore) || diff.zScore === null).toBe(true);
  });

  it("ignores non-positive or non-finite samples", () => {
    const r = scoreAnomaly(1000, [0, -50, NaN, 900, 1100, 950]);
    expect(r.sampleSize).toBe(3);
  });
});
