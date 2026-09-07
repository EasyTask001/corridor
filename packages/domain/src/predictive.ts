import { z } from "zod";
import { uuid } from "./common";
import { cargoInput, crossingPoint } from "./movement";

export const suggestedCargo = cargoInput.omit({
  entryNumber: true,
  inBondNumber: true,
  sourceDocumentId: true,
  extractionConfidence: true,
});

/** Historical values offered to a dispatcher; nothing is applied until accept. */
export const movementSuggestionPayload = z.object({
  sourceMovementId: uuid,
  sourceMovementNumber: z.string().min(1).max(40),
  targetUpdatedAt: z.string().datetime(),
  crossingPoint: crossingPoint.nullable(),
  driverId: uuid.nullable(),
  truckId: uuid.nullable(),
  trailerId: uuid.nullable(),
  cargo: z.array(suggestedCargo).max(100),
});

export type MovementSuggestionPayload = z.infer<typeof movementSuggestionPayload>;
