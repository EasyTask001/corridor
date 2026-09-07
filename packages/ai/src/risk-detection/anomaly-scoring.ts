/**
 * Statistical outlier detection — pure, deterministic, explainable (no LLM).
 * Used to flag a shipment line whose weight or declared value is far outside
 * the historical range for the same lane (shipper + consignee, or crossing).
 */

export interface AnomalyResult {
  value: number;
  sampleSize: number;
  mean: number | null;
  stdDev: number | null;
  /** (value - mean) / stdDev, or null when there isn't enough history */
  zScore: number | null;
  isOutlier: boolean;
  /** signed % deviation from the mean, for a human-readable message */
  deviationPct: number | null;
}

/** Below this many historical points, we don't have enough signal to claim an anomaly. */
export const MIN_SAMPLE_SIZE = 3;
export const Z_SCORE_THRESHOLD = 2.5;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdDev(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Score `value` against `samples` (e.g. weights of the last N accepted
 * movements on the same lane). Samples should exclude the value being tested.
 */
export function scoreAnomaly(value: number, samples: number[]): AnomalyResult {
  const clean = samples.filter((s) => Number.isFinite(s) && s > 0);
  if (clean.length < MIN_SAMPLE_SIZE) {
    return {
      value,
      sampleSize: clean.length,
      mean: null,
      stdDev: null,
      zScore: null,
      isOutlier: false,
      deviationPct: null,
    };
  }
  const m = mean(clean);
  const sd = stdDev(clean, m);
  // A lane with zero variance (identical historical values) treats any
  // difference as significant rather than dividing by zero.
  const z = sd > 0 ? (value - m) / sd : value === m ? 0 : Infinity;
  const deviationPct = m !== 0 ? ((value - m) / m) * 100 : null;
  return {
    value,
    sampleSize: clean.length,
    mean: m,
    stdDev: sd,
    zScore: Number.isFinite(z) ? z : null,
    isOutlier: Math.abs(z) >= Z_SCORE_THRESHOLD,
    deviationPct,
  };
}
