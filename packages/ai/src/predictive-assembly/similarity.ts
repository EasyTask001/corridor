import type { Regime } from "@corridor/domain";

export interface MovementFingerprint {
  id: string;
  regime: Regime;
  crossingCode: string | null;
  shipperId: string | null;
  consigneeId: string | null;
  createdAt: Date;
}

export interface RankedMovement {
  movementId: string;
  score: number;
  reasons: string[];
}

/** Explainable lane similarity. Structured history is safer and cheaper than an LLM here. */
export function rankSimilarMovements(
  target: MovementFingerprint,
  candidates: readonly MovementFingerprint[],
  now = new Date(),
): RankedMovement[] {
  return candidates
    .filter((candidate) => candidate.id !== target.id && candidate.regime === target.regime)
    .map((candidate) => {
      let score = 20;
      const reasons = [`same ${target.regime} filing regime`];

      if (target.crossingCode && candidate.crossingCode === target.crossingCode) {
        score += 30;
        reasons.push("same border crossing");
      }
      if (target.shipperId && candidate.shipperId === target.shipperId) {
        score += 20;
        reasons.push("same shipper");
      }
      if (target.consigneeId && candidate.consigneeId === target.consigneeId) {
        score += 20;
        reasons.push("same consignee");
      }

      const ageDays = Math.max(0, (now.getTime() - candidate.createdAt.getTime()) / 86_400_000);
      if (ageDays <= 30) {
        score += 10;
        reasons.push("used in the last 30 days");
      } else if (ageDays <= 180) {
        score += 5;
        reasons.push("used in the last 6 months");
      }

      return { movementId: candidate.id, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
}
