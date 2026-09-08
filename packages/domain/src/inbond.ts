import { z } from "zod";
import { nonEmpty, uuid } from "./common";
import { carrierCode, regime } from "./movement";
import { inBondEntryType } from "./shipment";

// ---------------------------------------------------------------------------
// In-bond moves (in_bond_records, migration 0026)
// ---------------------------------------------------------------------------

export const inBondStatus = z.enum([
  "open",
  "arrival_sent",
  "arrived",
  "export_sent",
  "exported",
  "cancelled",
]);
export type InBondStatus = z.infer<typeof inBondStatus>;

/** Mirrors in_bond_records_guard(): arrival, then export; cancel from anywhere live. */
export const IN_BOND_TRANSITIONS: Record<InBondStatus, readonly InBondStatus[]> = {
  open: ["arrival_sent", "cancelled"],
  arrival_sent: ["arrived", "open", "cancelled"],
  arrived: ["export_sent", "cancelled"],
  export_sent: ["exported", "arrived", "cancelled"],
  exported: [],
  cancelled: [],
};
export const canTransitionInBond = (from: InBondStatus, to: InBondStatus) =>
  IN_BOND_TRANSITIONS[from].includes(to);

export const IN_BOND_STATUS_LABELS: Record<InBondStatus, string> = {
  open: "Open",
  arrival_sent: "Arrival sent",
  arrived: "Arrived",
  export_sent: "Export sent",
  exported: "Exported",
  cancelled: "Cancelled",
};

/** CBP in-bond (bond) number: nine digits. */
export const bondNumber = z
  .string()
  .trim()
  .regex(/^\d{9}$/, "Bond number is 9 digits");

/** FIRMS code of the bonded facility: four alphanumerics. */
export const firmsCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4}$/, "FIRMS code is 4 characters");

const recordFields = {
  bondNumber: bondNumber.nullable().optional(),
  entryType: inBondEntryType,
  arrivalPortId: uuid.nullable().optional(),
  exportPortId: uuid.nullable().optional(),
  firmsCode: firmsCode.nullable().optional(),
};

/** Exactly one parent: one of our shipments, or an external one. */
export const inBondRecordInput = z
  .object({
    shipmentId: uuid.optional(),
    externalShipmentId: uuid.optional(),
    ...recordFields,
  })
  .refine((v) => !!v.shipmentId !== !!v.externalShipmentId, {
    message: "Choose a shipment or an external shipment, not both",
    path: ["shipmentId"],
  });
export type InBondRecordInput = z.infer<typeof inBondRecordInput>;

export const inBondRecordPatch = z.object({
  id: uuid,
  ...recordFields,
  entryType: inBondEntryType.optional(),
});
export type InBondRecordPatch = z.infer<typeof inBondRecordPatch>;

/**
 * What CBP needs before an arrival / export / cancel message can be sent
 * (Avaal refuses to send without all three plus the bond).
 */
export const inBondSendable = z.object({
  bondNumber,
  arrivalPortId: uuid,
  exportPortId: uuid,
  firmsCode,
});

export const inBondListInput = z.object({
  status: z.array(inBondStatus).optional(),
  q: z.string().trim().max(60).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type InBondListInput = z.infer<typeof inBondListInput>;

export const inBondActionInput = z.object({ id: uuid });
export const inBondNoteInput = z.object({ id: uuid, body: nonEmpty.max(2000) });

export const inBondEventKind = z.enum([
  "arrival_sent",
  "export_sent",
  "cancel_sent",
  "status_requested",
  "customs_response",
  "note",
]);
export type InBondEventKind = z.infer<typeof inBondEventKind>;

// ---------------------------------------------------------------------------
// External shipments (external_shipments, migration 0026)
// ---------------------------------------------------------------------------

export const externalShipmentInput = z
  .object({
    regime,
    controlNumber: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{4,24}$/, "4–24 letters or digits")
      .nullable()
      .optional(),
    inBondNumber: bondNumber.nullable().optional(),
    originatingCarrierCode: carrierCode.nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => !!v.controlNumber || !!v.inBondNumber, {
    message: "A control number or an in-bond number is required",
    path: ["controlNumber"],
  });
export type ExternalShipmentInput = z.infer<typeof externalShipmentInput>;

export const externalShipmentPatch = z.object({
  id: uuid,
  controlNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{4,24}$/, "4–24 letters or digits")
    .nullable()
    .optional(),
  inBondNumber: bondNumber.nullable().optional(),
  originatingCarrierCode: carrierCode.nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

export const externalShipmentListInput = z.object({
  status: z.enum(["open", "closed"]).optional(),
  q: z.string().trim().max(60).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
