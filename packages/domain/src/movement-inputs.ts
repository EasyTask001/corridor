import { z } from "zod";
import { isoDateTime, nonEmpty, uuid } from "./common";
import { carrierCode, iitIndicator, movementStatus, regime, sealInput } from "./movement";

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
  // 0022 — manifest flags. The ACI booleans are rejected by the DB on an ACE
  // movement, so the API only forwards them for ACI.
  iitIndicator: iitIndicator.optional(),
  aciLvs: z.boolean().optional(),
  aciPostal: z.boolean().optional(),
  aciFlyingTruck: z.boolean().optional(),
  aciInTransit: z.boolean().optional(),
  aciIit: z.boolean().optional(),
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

// ---------------------------------------------------------------------------
// Amendments
// ---------------------------------------------------------------------------

/**
 * CBSA ECCRD chapter 7 amendment reason codes, in the order CBSA lists them
 * (when several apply, the one nearest the top is used). `scope` says whether
 * the code belongs to a conveyance (trip header) or a cargo (shipment)
 * amendment; 60/80/85 are on both lists. Required on an ACI amendment
 * (zod refine in the API + trigger in migration 0022); CBP does not use them.
 */
export const CBSA_AMENDMENT_REASON_CODES = [
  { code: "40", scope: "conveyance", label: "Clerical error when keying conveyance data" },
  { code: "45", scope: "conveyance", label: "Duplicate CCD, need to cancel one (cargo to be de-linked)" },
  { code: "50", scope: "conveyance", label: "Entire shipment not laden (cargo to be de-linked)" },
  { code: "20", scope: "cargo", label: "Amendment to description of goods" },
  { code: "25", scope: "cargo", label: "Amendment to consignee (name and/or address)" },
  { code: "30", scope: "cargo", label: "In bond port / sub-location code amendment" },
  { code: "35", scope: "cargo", label: "Clerical error when keying cargo data" },
  { code: "65", scope: "cargo", label: "Overage: more pieces than reported at first port of arrival" },
  { code: "70", scope: "cargo", label: "Shortage: fewer pieces than reported at first port of arrival" },
  { code: "75", scope: "cargo", label: "Goods pilfered, stolen, lost or destroyed in the carrier's custody" },
  { code: "60", scope: "both", label: "Amendment not elsewhere specified" },
  { code: "80", scope: "both", label: "Change request delayed by client systems outage" },
  { code: "85", scope: "both", label: "Change request delayed by CBSA systems outage" },
] as const;
export const CBSA_AMENDMENT_REASON_CODE_VALUES = [
  "20",
  "25",
  "30",
  "35",
  "40",
  "45",
  "50",
  "60",
  "65",
  "70",
  "75",
  "80",
  "85",
] as const;
export const cbsaAmendmentReasonCode = z.enum(CBSA_AMENDMENT_REASON_CODE_VALUES);
export type CbsaAmendmentReasonCode = z.infer<typeof cbsaAmendmentReasonCode>;

export const amendmentInput = z.object({
  movementId: uuid,
  reason: nonEmpty.max(500),
  /** Required when the movement files under ACI (checked by the API and the DB). */
  reasonCode: cbsaAmendmentReasonCode.optional(),
  /** The shipment the amendment is about; omitted = the trip header. */
  shipmentId: uuid.optional(),
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
