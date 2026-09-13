/**
 * Deterministic, explainable risk checks for a movement's shipment lines —
 * NOT LLM-based. Combines HS-code/commodity-description consistency, lane
 * anomaly scoring, and the hold-prediction heuristic into compliance-alert
 * findings the API layer persists (packages/api/src/services/risk.ts).
 */
import type { AlertSeverity } from "@corridor/domain";
import { scoreAnomaly, type AnomalyResult } from "./anomaly-scoring";
import { predictHold, type HoldPrediction } from "./hold-prediction";

export interface TariffLookup {
  hsCode: string;
  description: string;
  dataQuality: "synthetic_demo" | "authoritative";
}

export interface RiskCargoLine {
  lineNumber: number;
  commodityDescription: string;
  hsCode: string | null;
  weightKg: number | null;
  valueAmount: number | null;
  /** Broker presence on this line's own shipment, never movement-wide. */
  hasBroker: boolean;
}

export interface LaneHistory {
  /** past weights/values for the same lane, most recent first, excluding the current movement */
  weights: number[];
  values: number[];
  /** true if any past movement on this lane was rejected within the last 90 days */
  rejectedRecently: boolean;
}

export interface RiskInput {
  movementId: string;
  cargo: RiskCargoLine[];
  lane: LaneHistory;
  /** injected so the engine has no I/O of its own */
  lookupTariff: (hsCode: string) => TariffLookup | null;
}

export interface RiskFinding {
  alertType: "hs_code_mismatch" | "risk_flag" | "hold_prediction";
  severity: AlertSeverity;
  title: string;
  description: string;
  dedupeKey: string;
  metadata: Record<string, unknown>;
}

/** Very small keyword-overlap check — no ML, just tokens in common. */
export function hsDescriptionMismatch(commodity: string, tariff: TariffLookup): boolean {
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
  const a = norm(commodity);
  const b = norm(tariff.description);
  if (a.size === 0 || b.size === 0) return false;
  let overlap = 0;
  for (const w of Array.from(a)) if (b.has(w)) overlap++;
  return overlap === 0;
}

export function evaluateMovementRisk(input: RiskInput): RiskFinding[] {
  const findings: RiskFinding[] = [];
  let anyWeightOutlier = false;
  let anyValueOutlier = false;
  let anyHsMismatch = false;

  for (const line of input.cargo) {
    const key = `movement:${input.movementId}:line:${line.lineNumber}`;

    if (line.hsCode) {
      const tariff = input.lookupTariff(line.hsCode);
      if (
        tariff?.dataQuality === "authoritative" &&
        hsDescriptionMismatch(line.commodityDescription, tariff)
      ) {
        anyHsMismatch = true;
        findings.push({
          alertType: "hs_code_mismatch",
          severity: "warning",
          title: `HS code ${line.hsCode} may not match "${line.commodityDescription}" (line ${line.lineNumber})`,
          description: `Tariff ${line.hsCode} is classified as "${tariff.description}", which shares no keywords with the declared commodity description. Verify the HS code before transmitting.`,
          dedupeKey: `${key}:hs_mismatch`,
          metadata: {
            lineNumber: line.lineNumber,
            hsCode: line.hsCode,
            tariffDescription: tariff.description,
          },
        });
      }
    }

    if (line.weightKg != null) {
      const a = scoreAnomaly(line.weightKg, input.lane.weights);
      if (a.isOutlier) {
        anyWeightOutlier = true;
        findings.push(anomalyFinding(key, "weight", line.lineNumber, line.weightKg, "kg", a));
      }
    }
    if (line.valueAmount != null) {
      const a = scoreAnomaly(line.valueAmount, input.lane.values);
      if (a.isOutlier) {
        anyValueOutlier = true;
        findings.push(anomalyFinding(key, "value", line.lineNumber, line.valueAmount, "", a));
      }
    }
  }

  const hold: HoldPrediction = predictHold({
    rejectedRecently: input.lane.rejectedRecently,
    weightOutlier: anyWeightOutlier,
    valueOutlier: anyValueOutlier,
    missingBroker: input.cargo.some((c) => (c.valueAmount ?? 0) > 25_000 && !c.hasBroker),
    hsMismatch: anyHsMismatch,
  });
  if (hold.likely) {
    findings.push({
      alertType: "hold_prediction",
      severity: hold.score >= 0.75 ? "critical" : "warning",
      title: `Inspection Risk — ${Math.round(hold.score * 100)} / 100 · Elevated`,
      description: hold.factors
        .map((factor) => `${factor.impact} impact: ${factor.label}.`)
        .join(" "),
      dedupeKey: `movement:${input.movementId}:hold_prediction`,
      metadata: { score: Math.round(hold.score * 100), factors: hold.factors },
    });
  }

  return findings;
}

function anomalyFinding(
  key: string,
  kind: "weight" | "value",
  lineNumber: number,
  observed: number,
  unit: string,
  a: AnomalyResult,
): RiskFinding {
  const direction = (a.deviationPct ?? 0) >= 0 ? "above" : "below";
  const pct = a.deviationPct != null ? Math.abs(Math.round(a.deviationPct)) : null;
  return {
    alertType: "risk_flag",
    severity: Math.abs(a.zScore ?? 0) >= 4 ? "critical" : "warning",
    title: `Line ${lineNumber} ${kind} is ${pct ?? "significantly"}% ${direction} this lane's average`,
    description: `Declared ${kind} of ${observed}${unit ? ` ${unit}` : ""} compares to a historical average of ${a.mean?.toFixed(1)}${unit ? ` ${unit}` : ""} over ${a.sampleSize} prior shipments (z=${a.zScore?.toFixed(2)}).`,
    dedupeKey: `${key}:${kind}_anomaly`,
    metadata: {
      lineNumber,
      kind,
      observed,
      mean: a.mean,
      stdDev: a.stdDev,
      zScore: a.zScore,
      sampleSize: a.sampleSize,
    },
  };
}
