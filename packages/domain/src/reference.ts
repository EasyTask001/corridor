import { z } from "zod";
import { uuid } from "./common";
import { carrierCode, regime } from "./movement";

/** Matches public.ports.kind (migration 0018). */
export const portKind = z.enum([
  "port_of_entry",
  "in_bond_destination",
  "cbsa_office",
  "firms",
  "sublocation",
]);
export type PortKind = z.infer<typeof portKind>;

export const portCountry = z.enum(["US", "CA"]);

export const portSchema = z.object({
  id: uuid,
  regime,
  kind: portKind,
  code: z.string(),
  name: z.string(),
  stateProvince: z.string().nullable(),
  country: portCountry,
  parentCode: z.string().nullable(),
  active: z.boolean(),
});
export type Port = z.infer<typeof portSchema>;

export const portsSearchInput = z.object({
  regime: regime.optional(),
  kind: portKind.optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type PortsSearchInput = z.infer<typeof portsSearchInput>;

export const carrierCodeInput = z.object({
  regime,
  code: carrierCode,
  label: z.string().trim().max(120).optional(),
  isDefault: z.boolean().optional(),
});
export type CarrierCodeInput = z.infer<typeof carrierCodeInput>;

export const carrierCodeUpsertInput = carrierCodeInput.extend({ id: uuid.optional() });
export type CarrierCodeUpsertInput = z.infer<typeof carrierCodeUpsertInput>;

export const carrierCodeRemoveInput = z.object({ id: uuid });
export const carrierCodeSetDefaultInput = z.object({ id: uuid });

// ---------------------------------------------------------------------------
// Equipment types (X12 DE40 / ACE Appendix N — migration 0021)
// ---------------------------------------------------------------------------

/**
 * The truck-relevant subset of CBP's equipment description codes, in the
 * order the registry dropdown shows them. `public.equipment_types` is seeded
 * from the same list; the API's `reference.equipmentTypes.list` reads the
 * table so a later migration can extend it without a code change.
 */
export const EQUIPMENT_TYPES = [
  { code: "TL", label: "Trailer (not otherwise specified)" },
  { code: "TF", label: "Trailer, dry freight" },
  { code: "RT", label: "Controlled temperature trailer (reefer)" },
  { code: "TW", label: "Trailer, refrigerated" },
  { code: "TI", label: "Trailer, insulated" },
  { code: "TM", label: "Trailer, insulated/ventilated" },
  { code: "TA", label: "Trailer, heated/insulated/ventilated" },
  { code: "TQ", label: "Trailer, electric heat" },
  { code: "FT", label: "Flat bed trailer" },
  { code: "FH", label: "Flat bed trailer with headboards" },
  { code: "FR", label: "Flat bed trailer, removable sides" },
  { code: "OT", label: "Open-top / flatbed trailer" },
  { code: "SD", label: "Single-drop trailer (step deck)" },
  { code: "DD", label: "Double-drop trailer" },
  { code: "DT", label: "Drop back trailer" },
  { code: "RA", label: "Fixed-rack flatbed trailer (A-frame)" },
  { code: "RS", label: "Fixed-rack single-drop trailer" },
  { code: "RD", label: "Fixed-rack double-drop trailer" },
  { code: "ST", label: "Removable side trailer" },
  { code: "TT", label: "Telescoping trailer" },
  { code: "TB", label: "Trailer, board" },
  { code: "TC", label: "Trailer, car" },
  { code: "TP", label: "Trailer, pneumatic" },
  { code: "TG", label: "Trailer, tank (gas)" },
  { code: "TJ", label: "Trailer, tank (chemicals)" },
  { code: "TK", label: "Trailer, tank (food grade liquid)" },
  { code: "PT", label: "Protected trailer" },
  { code: "HV", label: "High cube van" },
  { code: "CV", label: "Close van" },
  { code: "OV", label: "Open top van" },
  { code: "SV", label: "Van, special dimensions" },
  { code: "CH", label: "Chassis" },
  { code: "CB", label: "Chassis, gooseneck" },
  { code: "CC", label: "Container resting on a chassis" },
  { code: "CN", label: "Container" },
  { code: "CL", label: "Container, closed top" },
  { code: "CU", label: "Container, open top" },
  { code: "CZ", label: "Refrigerated container" },
  { code: "CI", label: "Container, insulated" },
  { code: "CX", label: "Container, tank" },
  { code: "CG", label: "Container, tank (gas)" },
  { code: "CW", label: "Container, tank (chemicals)" },
  { code: "CQ", label: "Container, tank (food grade liquid)" },
  { code: "BK", label: "Container, bulk" },
  { code: "PL", label: "Container, platform" },
  { code: "LS", label: "Half height flat rack" },
  { code: "AC", label: "Closed container" },
  { code: "AT", label: "Closed container (controlled temperature)" },
  { code: "TV", label: "Truck, van" },
  { code: "TO", label: "Truck, open top" },
  { code: "TH", label: "Truck, open top high side" },
  { code: "TU", label: "Truck, open top low side" },
  { code: "PU", label: "Pick-up truck" },
  { code: "TR", label: "Tractor" },
  { code: "BG", label: "Bogie" },
  { code: "LU", label: "Load/unload device on equipment" },
  { code: "GS", label: "Generator set" },
] as const;

export const EQUIPMENT_TYPE_CODES = EQUIPMENT_TYPES.map((t) => t.code) as unknown as readonly [
  (typeof EQUIPMENT_TYPES)[number]["code"],
  ...(typeof EQUIPMENT_TYPES)[number]["code"][],
];
export const equipmentType = z.enum(EQUIPMENT_TYPE_CODES);
export type EquipmentType = z.infer<typeof equipmentType>;

export const EQUIPMENT_TYPE_LABELS: Record<EquipmentType, string> = Object.fromEntries(
  EQUIPMENT_TYPES.map((t) => [t.code, t.label]),
) as Record<EquipmentType, string>;

export const equipmentTypeSchema = z.object({
  code: equipmentType,
  label: z.string(),
  regimeScope: z.enum(["ACE", "ACI", "both"]),
});
