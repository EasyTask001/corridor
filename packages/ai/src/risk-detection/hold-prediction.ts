/**
 * Explainable hold-prediction heuristic — a weighted sum of concrete, named
 * risk factors, NOT a model. Every point in the score traces to a factor the
 * UI can print verbatim, so a dispatcher (or an auditor) can see exactly why
 * a movement was flagged. This must stay explainable as it evolves.
 */

export interface RiskFactor {
  key: string;
  label: string;
  impact: "High" | "Medium" | "Low";
  present: boolean;
}

export interface HoldPrediction {
  score: number; // 0..1
  likely: boolean;
  factors: RiskFactor[];
  reasons: string[];
}

export const HOLD_LIKELY_THRESHOLD = 0.5;

/** Named, fixed weights — changing these is a deliberate, reviewable edit. */
export const HOLD_FACTOR_WEIGHTS = {
  rejectedRecently: 0.35, // this lane/driver was rejected by customs in the last 90 days
  weightOutlier: 0.25, // declared weight is a statistical outlier for the lane
  valueOutlier: 0.2, // declared value is a statistical outlier for the lane
  missingBroker: 0.1, // high-value shipment with no customs broker on file
  hsMismatch: 0.3, // declared HS code doesn't match the commodity description
} as const;

export interface HoldPredictionInput {
  rejectedRecently: boolean;
  weightOutlier: boolean;
  valueOutlier: boolean;
  missingBroker: boolean;
  hsMismatch: boolean;
}

const LABELS: Record<keyof HoldPredictionInput, string> = {
  rejectedRecently: "This lane was rejected by customs within the last 90 days",
  weightOutlier: "Declared weight is a statistical outlier for this lane",
  valueOutlier: "Declared value is a statistical outlier for this lane",
  missingBroker: "High-value shipment with no customs broker on file",
  hsMismatch: "Declared HS code does not match the commodity description",
};

export function predictHold(input: HoldPredictionInput): HoldPrediction {
  const allFactors = (Object.keys(HOLD_FACTOR_WEIGHTS) as (keyof HoldPredictionInput)[]).map(
    (key) => ({
      key,
      label: LABELS[key],
      weight: HOLD_FACTOR_WEIGHTS[key],
      present: input[key],
    }),
  );
  const raw = allFactors.reduce((s, f) => s + (f.present ? f.weight : 0), 0);
  const maxPossible = Object.values(HOLD_FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
  const factors: RiskFactor[] = allFactors
    .filter((factor) => factor.present)
    .map(({ key, label, weight, present }) => ({
      key,
      label,
      impact: weight >= 0.3 ? "High" : weight >= 0.2 ? "Medium" : "Low",
      present,
    }));
  const score = Math.min(1, raw / maxPossible);
  return {
    score,
    likely: score >= HOLD_LIKELY_THRESHOLD,
    factors,
    reasons: factors.filter((f) => f.present).map((f) => f.label),
  };
}
