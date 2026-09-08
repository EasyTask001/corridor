import { z } from "zod";
import { uuid } from "./common";
import { crewRole } from "./movement-inputs";

/**
 * Historical values offered to a dispatcher; nothing is applied until accept.
 *
 * Only the lane and the equipment are suggested. Commodity lines are NOT:
 * since 0019 they belong to a shipment, and a shipment is identified by a real
 * PAPS/PARS control number that cannot be cloned from an earlier trip. Reusing
 * a past shipment is what `shipment.assign` is for.
 */
export const movementSuggestionPayload = z.object({
  sourceMovementId: uuid,
  sourceMovementNumber: z.string().min(1).max(40),
  targetUpdatedAt: z.string().datetime(),
  /** Snapshot of the source movement's port — an id plus the code/name it
   * carried at generation time, since the payload must stay meaningful even
   * if the port catalogue changes later. */
  port: z.object({ id: uuid, code: z.string(), name: z.string() }).nullable(),
  carrierCode: z.string().nullable(),
  /** The source movement's crew, offered as a whole (0020). */
  crew: z.array(z.object({ driverId: uuid, role: crewRole })),
  truckId: uuid.nullable(),
  /** The source movement's trailers in tow order (0021). */
  trailerIds: z.array(uuid),
});

export type MovementSuggestionPayload = z.infer<typeof movementSuggestionPayload>;
