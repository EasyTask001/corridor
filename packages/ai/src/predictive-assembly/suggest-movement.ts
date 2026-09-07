import { rankSimilarMovements, type MovementFingerprint, type RankedMovement } from "./similarity";

export function suggestMovement(
  target: MovementFingerprint,
  history: readonly MovementFingerprint[],
  now = new Date(),
): RankedMovement | null {
  return rankSimilarMovements(target, history, now)[0] ?? null;
}
