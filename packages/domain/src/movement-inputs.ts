import { z } from "zod";
import { isoDateTime, nonEmpty, uuid } from "./common";
import { cargoInput, crossingPoint, movementStatus, regime, sealInput } from "./movement";

export const movementListInput = z.object({
  status: z.array(movementStatus).optional(),
  regime: regime.optional(),
  search: z.string().trim().max(100).optional(),
  driverId: uuid.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type MovementListInput = z.infer<typeof movementListInput>;

/** Editable header fields (draft / rejected only). */
export const movementPatch = z.object({
  tripNumber: z.string().trim().max(40).nullable().optional(),
  crossingPoint: crossingPoint.nullable().optional(),
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

/** Well-known crossing points for the wizard dropdown (CBP port / CBSA office codes). */
export const CROSSING_POINTS: ReadonlyArray<{ code: string; name: string; regime: "ACE" | "ACI" }> =
  [
    { code: "3801", name: "Detroit — Ambassador Bridge, MI", regime: "ACE" },
    { code: "3802", name: "Port Huron — Blue Water Bridge, MI", regime: "ACE" },
    { code: "0901", name: "Buffalo — Peace Bridge, NY", regime: "ACE" },
    { code: "0712", name: "Lewiston — Queenston Bridge, NY", regime: "ACE" },
    { code: "3004", name: "Blaine — Pacific Highway, WA", regime: "ACE" },
    { code: "0209", name: "Champlain — Rouses Point, NY", regime: "ACE" },
    { code: "0453", name: "Windsor — Ambassador Bridge, ON", regime: "ACI" },
    { code: "0440", name: "Sarnia — Blue Water Bridge, ON", regime: "ACI" },
    { code: "0410", name: "Fort Erie — Peace Bridge, ON", regime: "ACI" },
    { code: "0427", name: "Queenston — Lewiston Bridge, ON", regime: "ACI" },
    { code: "0813", name: "Pacific Highway, BC", regime: "ACI" },
    { code: "0351", name: "Lacolle — Route 15, QC", regime: "ACI" },
  ];
