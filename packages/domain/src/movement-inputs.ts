import { z } from "zod";
import { isoDateTime, nonEmpty, uuid } from "./common";
import { cargoInput, carrierCode, movementStatus, regime, sealInput } from "./movement";

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
  driverId: uuid.nullable().optional(),
  truckId: uuid.nullable().optional(),
  trailerId: uuid.nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});
export type MovementPatch = z.infer<typeof movementPatch>;

export const cargoUpsertInput = cargoInput.extend({
  id: uuid.optional(),
  movementId: uuid,
});
export const cargoRemoveInput = z.object({ movementId: uuid, id: uuid });

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
