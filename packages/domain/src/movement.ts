import { z } from "zod";
import { isoDateTime, nonEmpty, uuid } from "./common";

// ---------------------------------------------------------------------------
// Regime & status
// ---------------------------------------------------------------------------

/** ACE = US CBP (southbound into the US). ACI = Canada CBSA (northbound into Canada). */
export const regime = z.enum(["ACE", "ACI"]);
export type Regime = z.infer<typeof regime>;

export const movementStatus = z.enum([
  "draft",
  "sent",
  "accepted",
  "rejected",
  "released",
  "held",
  "arrived",
  "cancelled",
]);
export type MovementStatus = z.infer<typeof movementStatus>;

/**
 * Server-enforced state machine. Every transition is applied only through
 * `transition()`; the tRPC router and the `movement_events` trigger both use
 * this table so the API and the audit trail can never disagree.
 */
export const MOVEMENT_TRANSITIONS: Record<MovementStatus, readonly MovementStatus[]> = {
  draft: ["sent", "cancelled"],
  sent: ["accepted", "rejected", "cancelled"],
  rejected: ["draft", "sent", "cancelled"],
  accepted: ["released", "held", "cancelled", "sent"], // "sent" = amendment re-transmit
  held: ["released", "cancelled"],
  released: ["arrived", "cancelled"],
  arrived: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: readonly MovementStatus[] = ["arrived", "cancelled"];

export function canTransition(from: MovementStatus, to: MovementStatus): boolean {
  return MOVEMENT_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  override readonly name = "InvalidTransitionError";
  constructor(
    public readonly from: MovementStatus,
    public readonly to: MovementStatus,
  ) {
    super(`Cannot transition movement from '${from}' to '${to}'`);
  }
}

/** Returns the target status or throws `InvalidTransitionError`. */
export function transition(from: MovementStatus, to: MovementStatus): MovementStatus {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

/** Which actor types may drive a given transition. Customs responses may not be user-initiated. */
export const actorType = z.enum(["user", "system", "customs_api", "ai"]);
export type ActorType = z.infer<typeof actorType>;

export const TRANSITION_ACTORS: Partial<
  Record<`${MovementStatus}->${MovementStatus}`, readonly ActorType[]>
> = {
  "sent->accepted": ["customs_api", "system"],
  "sent->rejected": ["customs_api", "system"],
  "accepted->released": ["customs_api", "system"],
  "accepted->held": ["customs_api", "system"],
  "held->released": ["customs_api", "system"],
};

export function actorMayTransition(
  actor: ActorType,
  from: MovementStatus,
  to: MovementStatus,
): boolean {
  const allowed = TRANSITION_ACTORS[`${from}->${to}`];
  return allowed ? allowed.includes(actor) : true;
}

/** Which statuses a movement may be edited in (cargo, crew, seals...). */
export const EDITABLE_STATUSES: readonly MovementStatus[] = ["draft", "rejected"];
export function isEditable(status: MovementStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

/** 2-4 alphanumerics: an ACE SCAC-style code or an ACI carrier code. */
export const carrierCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,4}$/, "Carrier code must be 2-4 alphanumeric characters");

/** Instruments of International Traffic — Avaal's three options (0022). */
export const IIT_INDICATORS = ["none", "iit_carrier_bond", "iit_importer_bond"] as const;
export const iitIndicator = z.enum(IIT_INDICATORS);
export type IitIndicator = z.infer<typeof iitIndicator>;
export const IIT_INDICATOR_LABELS: Record<IitIndicator, string> = {
  none: "None",
  iit_carrier_bond: "IIT under carrier bond",
  iit_importer_bond: "IIT under importer bond",
};

/** CBSA ACI trip flags; always false on an ACE manifest (DB check). */
export const ACI_FLAG_KEYS = [
  "aciLvs",
  "aciPostal",
  "aciFlyingTruck",
  "aciInTransit",
  "aciIit",
] as const;
export type AciFlagKey = (typeof ACI_FLAG_KEYS)[number];
export const ACI_FLAG_LABELS: Record<AciFlagKey, string> = {
  aciLvs: "Low value shipment (LVS)",
  aciPostal: "Postal",
  aciFlyingTruck: "Flying truck",
  aciInTransit: "In transit",
  aciIit: "IIT (instruments of international traffic)",
};

export const movementSchema = z.object({
  id: uuid,
  organizationId: uuid,
  regime,
  movementNumber: nonEmpty.max(40),
  tripNumber: z.string().trim().max(40).nullable(),
  status: movementStatus,
  portId: uuid.nullable(),
  carrierCode: z.string().nullable(),
  scheduledCrossingAt: isoDateTime.nullable(),
  truckId: uuid.nullable(),
  /** "Empty Trailer" (ACE) / "Empty Trip" (ACI) — migration 0021. */
  isEmpty: z.boolean(),
  iitIndicator,
  aciLvs: z.boolean(),
  aciPostal: z.boolean(),
  aciFlyingTruck: z.boolean(),
  aciInTransit: z.boolean(),
  aciIit: z.boolean(),
  customsReferenceNumber: z.string().nullable(),
  submittedAt: isoDateTime.nullable(),
  acceptedAt: isoDateTime.nullable(),
  rejectedAt: isoDateTime.nullable(),
  releasedAt: isoDateTime.nullable(),
  arrivedAt: isoDateTime.nullable(),
  createdBy: uuid.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Movement = z.infer<typeof movementSchema>;

export const createMovementInput = z.object({
  regime,
  tripNumber: z.string().trim().max(40).optional(),
  portId: uuid.optional(),
  /** Server defaults to the regime's default carrier code when omitted. */
  carrierCode: carrierCode.optional(),
  scheduledCrossingAt: isoDateTime.optional(),
  truckId: uuid.optional(),
  isEmpty: z.boolean().optional(),
});
export type CreateMovementInput = z.infer<typeof createMovementInput>;

export const updateMovementInput = createMovementInput.partial().extend({ id: uuid });
export type UpdateMovementInput = z.infer<typeof updateMovementInput>;

export const movementEventType = z.enum([
  "status_change",
  "amendment",
  "note",
  "customs_response",
  "ai_flag",
  /** 0022 — one gateway message (sending, accepted, entry on file, …). */
  "customs_event",
]);
export type MovementEventType = z.infer<typeof movementEventType>;

export const movementEventSchema = z.object({
  id: uuid,
  movementId: uuid,
  organizationId: uuid,
  eventType: movementEventType,
  fromStatus: movementStatus.nullable(),
  toStatus: movementStatus.nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  actorType,
  actorId: uuid.nullable(),
  occurredAt: isoDateTime,
});
export type MovementEvent = z.infer<typeof movementEventSchema>;

// ---------------------------------------------------------------------------
// Shared commodity value types. The commodity line itself lives in
// shipment.ts — it hangs off a shipment, not a movement (migration 0019).
// ---------------------------------------------------------------------------

export const currency = z.enum(["USD", "CAD"]);
/** Money as the DB stores it: numeric(14,2) — cents precision, non-negative, < 10^12. */
export const moneyAmount = z.number().nonnegative().max(999_999_999_999.99).multipleOf(0.01);
/** Round a raw (e.g. AI-extracted) amount to cents before it hits `moneyAmount`. */
export const roundToCents = (n: number): number => Math.round(n * 100) / 100;
export const hsCode = z
  .string()
  .trim()
  .regex(/^\d{4}(\.\d{2}(\.\d{2}(\.\d{2})?)?)?$/, "HS code must be 4–10 digits (e.g. 8471.30)");
export const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .length(2, "ISO 3166-1 alpha-2 country code");

export const sealInput = z.object({
  /** The movement_trailers slot the seal is on; null/absent = a seal on the truck. */
  movementTrailerId: uuid.nullable().optional(),
  sealNumber: nonEmpty.max(40),
  sealType: z.string().trim().max(40).nullable().optional(),
  appliedBy: z.string().trim().max(120).nullable().optional(),
  appliedAt: isoDateTime.nullable().optional(),
});
export type SealInput = z.infer<typeof sealInput>;
