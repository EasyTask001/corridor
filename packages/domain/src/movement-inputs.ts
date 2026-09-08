import { z } from "zod";
import { isoDateTime, nonEmpty, uuid } from "./common";
import { carrierCode, movementStatus, regime, sealInput } from "./movement";

export const movementListInput = z.object({
  status: z.array(movementStatus).optional(),
  regime: regime.optional(),
  search: z.string().trim().max(100).optional(),
  driverId: uuid.optional(),
  portId: uuid.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type MovementListInput = z.infer<typeof movementListInput>;

/** Editable header fields (draft / rejected only). */
export const movementPatch = z.object({
  tripNumber: z.string().trim().max(40).nullable().optional(),
  portId: uuid.nullable().optional(),
  /** Server defaults to the regime's default carrier code when omitted. */
  carrierCode: carrierCode.nullable().optional(),
  scheduledCrossingAt: isoDateTime.nullable().optional(),
  truckId: uuid.nullable().optional(),
  /** "Empty Trailer" (ACE) / "Empty Trip" (ACI). Trailers themselves are a
   * child list — see `trailerAddInput`. */
  isEmpty: z.boolean().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});
export type MovementPatch = z.infer<typeof movementPatch>;

// ---------------------------------------------------------------------------
// Crew
// ---------------------------------------------------------------------------

/**
 * Exactly one `person_in_charge` per crossing (movement_crew_pic_unique in
 * migration 0020); everyone else is a working crew member or a passenger.
 */
export const CREW_ROLES = ["person_in_charge", "crew_member", "passenger"] as const;
export const crewRole = z.enum(CREW_ROLES);
export type CrewRole = z.infer<typeof crewRole>;

export const crewInput = z.object({
  movementId: uuid,
  driverId: uuid,
  role: crewRole.default("crew_member"),
});
export type CrewInput = z.infer<typeof crewInput>;

export const crewRemoveInput = z.object({ movementId: uuid, driverId: uuid });
export const crewSetRoleInput = z.object({ movementId: uuid, driverId: uuid, role: crewRole });

// ---------------------------------------------------------------------------
// Trailers (movement_trailers, migration 0021)
// ---------------------------------------------------------------------------

export const trailerAddInput = z.object({ movementId: uuid, trailerId: uuid });
export type TrailerAddInput = z.infer<typeof trailerAddInput>;
export const trailerRemoveInput = z.object({ movementId: uuid, trailerId: uuid });
/** The full tow order — every trailer currently on the movement, first to last. */
export const trailerReorderInput = z.object({
  movementId: uuid,
  trailerIds: z.array(uuid).min(1).max(4),
});
export type TrailerReorderInput = z.infer<typeof trailerReorderInput>;

export const sealAddInput = sealInput.extend({ movementId: uuid });
export const sealRemoveInput = z.object({ movementId: uuid, id: uuid });

export const movementNoteInput = z.object({ movementId: uuid, body: nonEmpty.max(4000) });

export const amendmentInput = z.object({
  movementId: uuid,
  reason: nonEmpty.max(500),
  patch: movementPatch,
});
export type AmendmentInput = z.infer<typeof amendmentInput>;

/** Customs decisions (Phase 3 mock clients / Phase 2 dev simulation). */
export const customsResponseInput = z.object({
  movementId: uuid,
  decision: z.enum(["accepted", "rejected", "released", "held"]),
  referenceNumber: z.string().trim().max(60).optional(),
  message: z.string().trim().max(2000).optional(),
});
export type CustomsResponseInput = z.infer<typeof customsResponseInput>;
