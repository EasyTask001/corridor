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
  driverId: uuid.nullable(),
  truckId: uuid.nullable(),
  trailerId: uuid.nullable(),
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
  driverId: uuid.optional(),
  truckId: uuid.optional(),
  trailerId: uuid.optional(),
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
// Cargo — the SAME schema validates AI extraction output and the DB insert.
// ---------------------------------------------------------------------------

export const currency = z.enum(["USD", "CAD"]);
export const hsCode = z
  .string()
  .trim()
  .regex(/^\d{4}(\.\d{2}(\.\d{2}(\.\d{2})?)?)?$/, "HS code must be 4–10 digits (e.g. 8471.30)");
export const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .length(2, "ISO 3166-1 alpha-2 country code");

export const cargoInput = z.object({
  shipperId: uuid.nullable().optional(),
  consigneeId: uuid.nullable().optional(),
  commodityDescription: nonEmpty.max(500),
  hsCode: hsCode.nullable().optional(),
  weightKg: z.number().positive().max(100_000).nullable().optional(),
  pieceCount: z.number().int().positive().nullable().optional(),
  packagingType: z.string().trim().max(60).nullable().optional(),
  entryNumber: z.string().trim().max(40).nullable().optional(),
  inBondNumber: z.string().trim().max(40).nullable().optional(),
  valueAmount: z.number().nonnegative().nullable().optional(),
  valueCurrency: currency.nullable().optional(),
  countryOfOrigin: countryCode.nullable().optional(),
  sourceDocumentId: uuid.nullable().optional(),
  /** 0..1 — populated only when the row originated from AI extraction. */
  extractionConfidence: z.number().min(0).max(1).nullable().optional(),
});
export type CargoInput = z.infer<typeof cargoInput>;

export const cargoSchema = cargoInput.extend({
  id: uuid,
  movementId: uuid,
  organizationId: uuid,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Cargo = z.infer<typeof cargoSchema>;

export const sealInput = z.object({
  trailerId: uuid.nullable().optional(),
  sealNumber: nonEmpty.max(40),
  sealType: z.string().trim().max(40).nullable().optional(),
  appliedBy: z.string().trim().max(120).nullable().optional(),
  appliedAt: isoDateTime.nullable().optional(),
});
export type SealInput = z.infer<typeof sealInput>;
