import { z } from "zod";
import { uuid } from "./common";
import { cargoInput } from "./movement";

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
  /** Snapshot of the source movement's port — an id plus the code/name it
   * carried at generation time, since the payload must stay meaningful even
   * if the port catalogue changes later. */
  port: z.object({ id: uuid, code: z.string(), name: z.string() }).nullable(),
  carrierCode: z.string().nullable(),
  driverId: uuid.nullable(),
  truckId: uuid.nullable(),
  trailerId: uuid.nullable(),
  cargo: z.array(suggestedCargo).max(100),
});

export type MovementSuggestionPayload = z.infer<typeof movementSuggestionPayload>;
