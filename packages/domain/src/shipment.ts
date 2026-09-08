import { z } from "zod";
import { isoDateTime, nonEmpty, uuid } from "./common";
import { carrierCode, countryCode, currency, hsCode, regime } from "./movement";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/** ACE (US CBP) files a shipment type… */
export const ACE_SHIPMENT_TYPES = [
  "regular_bill",
  "section_321",
  "goods_astray",
  "free_of_duty_7523",
  "free_return_us_goods_3311",
  "unaccounted_articles_3299",
  "in_bond",
] as const;
export const aceShipmentType = z.enum(ACE_SHIPMENT_TYPES);
export type AceShipmentType = z.infer<typeof aceShipmentType>;

/** …ACI (CBSA) files a cargo type. Never both, never neither (DB check too). */
export const ACI_CARGO_TYPES = ["regular", "consolidated", "csa", "a49", "e29b"] as const;
export const aciCargoType = z.enum(ACI_CARGO_TYPES);
export type AciCargoType = z.infer<typeof aciCargoType>;

export const inBondEntryType = z.enum(["IT", "TE", "IE"]);
export type InBondEntryType = z.infer<typeof inBondEntryType>;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const shipmentStatus = z.enum([
  "draft",
  "sent",
  "accepted",
  "rejected",
  "entry_on_file",
  "released",
  "held",
  "arrived",
  "cancelled",
]);
export type ShipmentStatus = z.infer<typeof shipmentStatus>;

/**
 * A shipment's own state machine. It mirrors MOVEMENT_TRANSITIONS (a shipment
 * rides a movement and follows its customs decisions) with one extra state:
 * `entry_on_file`, the broker's entry landing before CBP releases the goods.
 */
export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  draft: ["sent", "cancelled"],
  sent: ["accepted", "rejected", "cancelled"],
  rejected: ["draft", "sent", "cancelled"],
  accepted: ["entry_on_file", "released", "held", "cancelled", "sent"],
  entry_on_file: ["released", "held", "cancelled"],
  held: ["released", "cancelled"],
  released: ["arrived", "cancelled"],
  arrived: [],
  cancelled: [],
};

export function canTransitionShipment(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return SHIPMENT_TRANSITIONS[from].includes(to);
}

/**
 * A customs decision on the movement cascades to the shipments riding it
 * (0022): the shipment moves to the same status when its own state machine
 * allows it, otherwise it stays put (e.g. `entry_on_file` is not undone by a
 * second `accepted`).
 */
export function cascadedShipmentStatus(
  current: ShipmentStatus,
  target: ShipmentStatus,
): ShipmentStatus | null {
  return canTransitionShipment(current, target) ? target : null;
}

/** Statuses in which a shipment may still be re-assigned to another movement. */
export const REASSIGNABLE_SHIPMENT_STATUSES: readonly ShipmentStatus[] = ["draft", "rejected"];

// ---------------------------------------------------------------------------
// Commodities
// ---------------------------------------------------------------------------

/** CBP/CBSA package units, as offered on the Avaal commodity form. */
export const CBP_QUANTITY_UNITS = [
  "Bag",
  "Bale",
  "Barrel",
  "Basket",
  "Box",
  "Bundle",
  "Can",
  "Carton",
  "Case",
  "Coil",
  "Crate",
  "Cylinder",
  "Drum",
  "Keg",
  "Pail",
  "Package",
  "Pallet",
  "Piece",
  "Reel",
  "Roll",
  "Sack",
  "Skid",
  "Tote",
  "Tube",
  "Unit",
] as const;
export const quantityUnit = z.enum(CBP_QUANTITY_UNITS);
export type QuantityUnit = z.infer<typeof quantityUnit>;

export const weightUnit = z.enum(["KG", "LB"]);
export type WeightUnit = z.infer<typeof weightUnit>;

/** One dangerous-goods declaration; CBP/CBSA accept at most three per line. */
export const hazmatEntry = z.object({
  unCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^UN\d{4}$/, "UN code must look like UN1203"),
  description: z.string().trim().max(300).nullable().optional(),
  emergencyContact: z.string().trim().max(120).nullable().optional(),
  emergencyPhone: z.string().trim().max(40).nullable().optional(),
});
export type HazmatEntry = z.infer<typeof hazmatEntry>;

export const commodityInput = z.object({
  commodityDescription: nonEmpty.max(500),
  hsCode: hsCode.nullable().optional(),
  /** Canonical weight in kilograms; `weightUnit` records what was entered. */
  weightKg: z.number().positive().max(100_000).nullable().optional(),
  weightUnit: weightUnit.default("KG"),
  quantity: z.number().int().positive().nullable().optional(),
  quantityUnit: quantityUnit.nullable().optional(),
  packagingType: z.string().trim().max(60).nullable().optional(),
  marksAndNumbers: z.string().trim().max(300).nullable().optional(),
  isConsolidated: z.boolean().default(false),
  valueAmount: z.number().nonnegative().nullable().optional(),
  valueCurrency: currency.nullable().optional(),
  countryOfOrigin: countryCode.nullable().optional(),
  sourceDocumentId: uuid.nullable().optional(),
  /** 0..1 — populated only when the row originated from AI extraction. */
  extractionConfidence: z.number().min(0).max(1).nullable().optional(),
  hazmat: z.array(hazmatEntry).max(3).default([]),
});
export type CommodityInput = z.infer<typeof commodityInput>;

export const commodityUpsertInput = commodityInput.extend({
  id: uuid.optional(),
  shipmentId: uuid,
});
export const commodityRemoveInput = z.object({ shipmentId: uuid, id: uuid });

// ---------------------------------------------------------------------------
// Shipment inputs
// ---------------------------------------------------------------------------

/** The carrier-assigned part of the control number (PAPS / PARS / bill). */
export const controlReference = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4,20}$/, "Control reference must be 4–20 letters or digits");

const address = z.object({
  line1: z.string().trim().max(160).optional(),
  line2: z.string().trim().max(160).optional(),
  city: z.string().trim().max(80).optional(),
  region: z.string().trim().max(80).optional(),
  postalCode: z.string().trim().max(20).optional(),
  country: z.string().trim().max(2).optional(),
});

const shipmentCommon = {
  controlReference,
  /** Server defaults to the regime's default carrier code when omitted. */
  carrierCode: carrierCode.optional(),
  movementId: uuid.nullable().optional(),
  isPars: z.boolean().default(false),
  shipperId: uuid.nullable().optional(),
  consigneeId: uuid.nullable().optional(),
  entryNumber: z.string().trim().max(40).nullable().optional(),
  entryPortId: uuid.nullable().optional(),
  inBondEntryType: inBondEntryType.nullable().optional(),
  inBondDestinationPortId: uuid.nullable().optional(),
  inBondNumber: z.string().trim().max(40).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
};

/** CBSA wants where the goods were loaded and where they are going. */
const aciOnly = {
  destinationPortId: uuid.nullable().optional(),
  sublocationPortId: uuid.nullable().optional(),
  loadingCountry: countryCode.nullable().optional(),
  loadingProvince: z.string().trim().max(60).nullable().optional(),
  loadingCity: z.string().trim().max(80).nullable().optional(),
  deliveryAddress: address.default({}),
  consigneeBusinessNumber: z.string().trim().max(20).nullable().optional(),
};

export const shipmentInput = z.discriminatedUnion("regime", [
  z.object({ regime: z.literal("ACE"), shipmentType: aceShipmentType, ...shipmentCommon }),
  z.object({ regime: z.literal("ACI"), cargoType: aciCargoType, ...shipmentCommon, ...aciOnly }),
]);
export type ShipmentInput = z.infer<typeof shipmentInput>;

/** Editable fields. The regime (and therefore the type field it implies) is immutable. */
export const shipmentPatch = z
  .object({
    ...shipmentCommon,
    ...aciOnly,
    shipmentType: aceShipmentType,
    cargoType: aciCargoType,
  })
  .omit({ movementId: true })
  .partial();
export type ShipmentPatch = z.infer<typeof shipmentPatch>;

export const shipmentListInput = z.object({
  regime: regime.optional(),
  status: z.array(shipmentStatus).optional(),
  /** Only shipments not yet attached to a movement. */
  unassignedOnly: z.boolean().optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ShipmentListInput = z.infer<typeof shipmentListInput>;

export const assignShipmentsInput = z.object({
  movementId: uuid,
  shipmentIds: z.array(uuid).min(1).max(100),
});
export type AssignShipmentsInput = z.infer<typeof assignShipmentsInput>;

export const shipmentSchema = z.object({
  id: uuid,
  organizationId: uuid,
  regime,
  movementId: uuid.nullable(),
  carrierCode: z.string(),
  shipmentType: aceShipmentType.nullable(),
  cargoType: aciCargoType.nullable(),
  controlReference: z.string(),
  controlNumber: z.string(),
  status: shipmentStatus,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Shipment = z.infer<typeof shipmentSchema>;
