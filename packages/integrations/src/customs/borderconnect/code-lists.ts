/**
 * Vendored BorderConnect reference/code lists.
 *
 * These are fetched from `https://borderconnect.com/data/**` — confirmed real
 * (curled and inspected 2026-09-12), unlike the `/emanifest-api/manual/*
 * -schema.json` URLs Task 4 found don't exist (see `../README.md`). There is
 * no live-fetch step at runtime: the lists rarely change, and a mapper that
 * depends on a network call at import time would make every test (and every
 * outage of borderconnect.com) a transport test. Each list below carries its
 * source URL in a comment so it can be re-vendored by hand if BorderConnect
 * ever changes it.
 */
import type { DriverDocumentType } from "@corridor/domain";

// ---------------------------------------------------------------------------
// Source: https://borderconnect.com/data/time-zones.json
//
// These are US time-zone *abbreviations* (PST/AST/CST/EST/MST), not IANA zone
// names (`America/Toronto`, …) — see `../README.md`, "Time zones". Because
// they aren't IANA, `bcDateTime`/the mappers never send
// `estimatedArrivalTimeZone`; they convert `carrier.timezone` (an IANA name)
// to a local wall-clock string via `Intl.DateTimeFormat` instead and stop
// there.
// ---------------------------------------------------------------------------
export const BC_TIME_ZONES = [
  { code: "PST", description: "Pacific Standard Time" },
  { code: "AST", description: "Atlantic Standard Time" },
  { code: "CST", description: "Central Standard Time" },
  { code: "EST", description: "Eastern Standard Time" },
  { code: "MST", description: "Mountain Standard Time" },
] as const;

// ---------------------------------------------------------------------------
// Source: https://borderconnect.com/data/trailer-types.json
// ---------------------------------------------------------------------------
export const BC_TRAILER_TYPES = [
  { code: "2B", description: "20 ft. Container (Closed top) sea container" },
  { code: "20", description: "20 ft. Container (Open top) sea container" },
  { code: "4B", description: "40 ft. Container (Closed top) sea container" },
  { code: "40", description: "40 ft. Container (Open top) sea container" },
  { code: "TC", description: "Auto carrier/trailer" },
  { code: "BI", description: "Beverage rack trailer" },
  { code: "CH", description: "Chassis" },
  { code: "RT", description: "Controlled temperature" },
  { code: "TW", description: "Controlled temperature trailer" },
  { code: "DD", description: "Double drop trailer" },
  { code: "DT", description: "Drop back trailer" },
  { code: "RD", description: "Fixed rack, Double drop trailer" },
  { code: "RS", description: "Fixed rack, Single drop trailer" },
  { code: "FT", description: "Flatbed/Perform trailer" },
  { code: "FR", description: "Flatbed trailer" },
  { code: "FH", description: "Flatbed trailer with headboards" },
  { code: "FN", description: "Flatbed trailer with no headboards" },
  { code: "RG", description: "Gondola (Closed)" },
  { code: "RO", description: "Gondola (Open)" },
  { code: "CB", description: "Gooseneck trailer" },
  { code: "HC", description: "Hopper car (Covered)" },
  { code: "HP", description: "Hopper car  (Covered; Pneumatic discharge)" },
  { code: "HO", description: "Hopper car (Open)" },
  { code: "HE", description: "Horse trailer" },
  { code: "LT", description: "Livestock trailer" },
  { code: "NC", description: "No equipment" },
  { code: "OE", description: "Other" },
  { code: "CL", description: "Other length sea container (Closed top)" },
  { code: "CU", description: "Other length sea container (Open top)" },
  { code: "CZ", description: "Refrigerated container" },
  { code: "TL", description: "Semi truck trailer" },
  { code: "SD", description: "Single drop trailer" },
  { code: "T8", description: "Tank trailer (Chemicals) - Heated/Insulated" },
  { code: "T6", description: "Tank trailer (Chemicals) - Heated/Not insulated" },
  { code: "T7", description: "Tank trailer (Chemicals) - Not heated/Insulated" },
  { code: "T5", description: "Tank trailer (Chemicals) - Not heated/Not insulated" },
  { code: "TK", description: "Tank trailer (Food grade liquids)" },
  { code: "T4", description: "Tank trailer (Gas) - Heated/Insulated" },
  { code: "T2", description: "Tank trailer (Gas) - Heated/Not insulated" },
  { code: "T3", description: "Tank trailer (Gas) - Not heated/Insulated" },
  { code: "T1", description: "Tank trailer (Gas) - Not heated/Not insulated" },
  { code: "L4", description: "Tank trailer (Liquids) - Heated/Insulated" },
  { code: "L2", description: "Tank trailer (Liquids) - Heated/Not insulated" },
  { code: "L3", description: "Tank trailer (Liquids) - Not heated/Insulated" },
  { code: "L1", description: "Tank trailer (Liquids) - Not heated/Not insulated" },
  { code: "TF", description: "Trailer (Dry freight)" },
] as const;

/**
 * Corridor `equipment_types.code` (packages/domain `EQUIPMENT_TYPES`) →
 * `BC_TRAILER_TYPES.code`. BorderConnect's list shares CBP's equipment
 * description vocabulary, so most Corridor codes have an identically-coded,
 * identically-described BorderConnect entry; those are mapped 1:1 below.
 * Codes with no confident BorderConnect equivalent (tank-trailer sub-types
 * split further than Corridor's TG/TJ, vans, generic containers, …) are
 * deliberately left out — `mapTrailerType` returns `undefined` for them and
 * the mapper 422s.
 */
export const TRAILER_TYPE_MAP: Readonly<Record<string, string>> = {
  CB: "CB",
  CH: "CH",
  CL: "CL",
  CU: "CU",
  CZ: "CZ",
  DD: "DD",
  DT: "DT",
  FH: "FH",
  FN: "FN",
  FR: "FR",
  FT: "FT",
  RD: "RD",
  RS: "RS",
  RT: "RT",
  SD: "SD",
  TC: "TC",
  TF: "TF",
  TK: "TK",
  TL: "TL",
  TW: "TW",
};

export function mapTrailerType(code: string): string | undefined {
  return TRAILER_TYPE_MAP[code];
}

// ---------------------------------------------------------------------------
// Source: https://borderconnect.com/data/travel-document-types.json
// ---------------------------------------------------------------------------
export const BC_TRAVEL_DOCUMENT_TYPES = [
  { code: "BCN", description: "Birth Certificate", stateProvinceRequired: false, countryRequired: true },
  { code: "CON", description: "Certificate of Naturalization", stateProvinceRequired: false, countryRequired: true },
  {
    code: "CDN",
    description: "Citizenship Document Number  (Citizenship Card)",
    stateProvinceRequired: false,
    countryRequired: true,
  },
  { code: "5K", description: "Commercial Driver's License", stateProvinceRequired: true, countryRequired: false },
  { code: "HD", description: "DOT Hazardous Number", stateProvinceRequired: true, countryRequired: false },
  { code: "5J", description: "Driver's License", stateProvinceRequired: true, countryRequired: false },
  { code: "6W", description: "Enhanced Drivers License", stateProvinceRequired: true, countryRequired: false },
  { code: "BCP", description: "Laser Visa Border Crossing Card", stateProvinceRequired: false, countryRequired: true },
  { code: "AAG", description: "Military ID Document", stateProvinceRequired: false, countryRequired: true },
  { code: "ALY", description: "Native American Indian/INAC", stateProvinceRequired: false, countryRequired: true },
  { code: "AEW", description: "NEXUS Card", stateProvinceRequired: false, countryRequired: true },
  { code: "OTD", description: "Other Travel Document ID", stateProvinceRequired: false, countryRequired: true },
  { code: "ACW", description: "Passport", stateProvinceRequired: false, countryRequired: true },
  {
    code: "AGS",
    description: "Permanent Resident Card C1 - US Resident",
    stateProvinceRequired: false,
    countryRequired: true,
  },
  {
    code: "ACU",
    description: "Permanent Resident Card C2 - Resident Commuter",
    stateProvinceRequired: false,
    countryRequired: false,
  },
  { code: "REP", description: "Reentry Permit", stateProvinceRequired: false, countryRequired: false },
  { code: "RTP", description: "Refugee Travel Permit", stateProvinceRequired: false, countryRequired: false },
  { code: "ALV", description: "SENTRI Card", stateProvinceRequired: false, countryRequired: true },
  { code: "AGR", description: "US Alien Registration Card A1", stateProvinceRequired: false, countryRequired: false },
  { code: "ALR", description: "US Alien Registration Card A2", stateProvinceRequired: false, countryRequired: true },
  {
    code: "ALX",
    description: "US Merchant Mariner Document ID",
    stateProvinceRequired: false,
    countryRequired: true,
  },
  { code: "AEF", description: "US Passport Card", stateProvinceRequired: false, countryRequired: true },
  { code: "30", description: "Visa - Immigrant", stateProvinceRequired: false, countryRequired: false },
  { code: "AGT", description: "Visa Non-Immigrant", stateProvinceRequired: false, countryRequired: true },
] as const;

/**
 * `DriverDocumentType` (packages/domain `registry.ts`) → `BC_TRAVEL_DOCUMENT_
 * TYPES.code`. Left out on purpose, so `travelDocuments` omits them per the
 * brief's "unmapped types omitted" rule:
 *  - `fast`: BorderConnect's list has no FAST-card entry at all (a FAST
 *    document still surfaces via `fastCardNumber`, matched by its own
 *    regex — see `ace.ts`).
 *  - `permanent_resident_card`: the list has *two* PR-card codes (`AGS` "C1 -
 *    US Resident" vs `ACU` "C2 - Resident Commuter") and Corridor's single
 *    `permanent_resident_card` value carries nothing to disambiguate between
 *    them — guessing one over the other risked filing the wrong document
 *    code, so it's left unmapped (flagged in the task report).
 *  - `us_alien_registration`: same shape of ambiguity (`AGR` "A1" vs `ALR`
 *    "A2").
 */
export const DRIVER_DOCUMENT_TYPE_MAP: Readonly<Partial<Record<DriverDocumentType, string>>> = {
  passport: "ACW",
  us_passport_card: "AEF",
  nexus: "AEW",
  sentri: "ALV",
  enhanced_drivers_license: "6W",
  visa_immigrant: "30",
  visa_non_immigrant: "AGT",
  laser_visa_bcc: "BCP",
  military_id: "AAG",
  merchant_mariner: "ALX",
  native_american_inac: "ALY",
  dhs_reentry_permit: "REP",
  dhs_refugee_travel: "RTP",
  birth_certificate: "BCN",
  citizenship_card: "CDN",
  certificate_of_naturalization: "CON",
  other: "OTD",
};

export function mapDriverDocumentType(type: DriverDocumentType): string | undefined {
  return DRIVER_DOCUMENT_TYPE_MAP[type];
}

// ---------------------------------------------------------------------------
// Source: https://borderconnect.com/data/us/ace/packaging-unit.json
// ---------------------------------------------------------------------------
export const ACE_PACKAGING_UNITS = [
  { code: "BAG", name: "Bag" },
  { code: "BLE", name: "Bale" },
  { code: "BBL", name: "Barrel" },
  { code: "BSK", name: "Basket" },
  { code: "BIN", name: "Bin" },
  { code: "BIC", name: "Bing Chest" },
  { code: "BOX", name: "Box" },
  { code: "BKT", name: "Bucket" },
  { code: "BDL", name: "Bundle" },
  { code: "CAN", name: "Can" },
  { code: "CCS", name: "Can Case" },
  { code: "CBY", name: "Carboy" },
  { code: "CAR", name: "Carcass" },
  { code: "CTN", name: "Carton" },
  { code: "CAS", name: "Case" },
  { code: "CSK", name: "Cask" },
  { code: "CHS", name: "Chest" },
  { code: "COL", name: "Coil" },
  { code: "CBC", name: "Container Bulk Cargo" },
  { code: "COR", name: "Cord" },
  { code: "CRT", name: "Crate" },
  { code: "CYL", name: "Cylinder" },
  { code: "DRM", name: "Drum" },
  { code: "DBK", name: "Dry Bulk" },
  { code: "GAL", name: "Gallon" },
  { code: "HMP", name: "Hamper" },
  { code: "HED", name: "Heads of Beef" },
  { code: "KEG", name: "Keg" },
  { code: "LVN", name: "Lift Van" },
  { code: "LBK", name: "Liquid Bulk" },
  { code: "LOG", name: "Logs" },
  { code: "LUG", name: "Lugs" },
  { code: "PKG", name: "Package" },
  { code: "PAL", name: "Pail" },
  { code: "PLT", name: "Pallet" },
  { code: "PCL", name: "Parcel" },
  { code: "PCS", name: "Pieces" },
  { code: "POV", name: "Private Vehicle" },
  { code: "QTR", name: "Quarters of Beef" },
  { code: "REL", name: "Reel" },
  { code: "ROL", name: "Roll" },
  { code: "SAK", name: "Sack" },
  { code: "SHT", name: "Sheet" },
  { code: "SID", name: "Sides of Beef" },
  { code: "SKD", name: "Skid" },
  { code: "TNK", name: "Tank" },
  { code: "TIN", name: "Tin" },
  { code: "TBN", name: "Tote Bin" },
  { code: "TBE", name: "Tube" },
  { code: "UNT", name: "Unit" },
  { code: "VPK", name: "Van Pack" },
  { code: "VEH", name: "Vehicle" },
  { code: "WLC", name: "Wheeled Carrier" },
  { code: "WDC", name: "Wooden Case" },
] as const;

// ---------------------------------------------------------------------------
// Source: https://borderconnect.com/data/ca/aci/packaging-unit.json
// ---------------------------------------------------------------------------
export const ACI_PACKAGING_UNITS = [
  { code: "PLL", name: "Air Pallet" },
  { code: "AMM", name: "Ammo Pack" },
  { code: "BAG", name: "Bag" },
  { code: "BAL", name: "Bale" },
  { code: "BDG", name: "Banding" },
  { code: "BRG", name: "Barge" },
  { code: "BBL", name: "Barrel" },
  { code: "BSK", name: "Basket or hamper" },
  { code: "BEM", name: "Beam" },
  { code: "BLT", name: "Belting" },
  { code: "BIN", name: "Bin" },
  { code: "BIC", name: "Bing Chest" },
  { code: "BOB", name: "Bobbin" },
  { code: "BOT", name: "Bottle" },
  { code: "BOX", name: "Box" },
  { code: "BXI", name: "Box, with inner container" },
  { code: "BRC", name: "Bracing" },
  { code: "BXT", name: "Bucket" },
  { code: "BKG", name: "Bulk Bag" },
  { code: "BDL", name: "Bundle" },
  { code: "CAB", name: "Cabinet" },
  { code: "CAG", name: "Cage" },
  { code: "CAN", name: "Can" },
  { code: "CCS", name: "Can Case" },
  { code: "CBY", name: "Carboy" },
  { code: "CLD", name: "Car Load, Rail" },
  { code: "CAR", name: "Carrier" },
  { code: "CTN", name: "Carton" },
  { code: "CAS", name: "Case" },
  { code: "CSK", name: "Cask" },
  { code: "CHE", name: "Cheeses" },
  { code: "CHS", name: "Chest" },
  { code: "COL", name: "Coil" },
  { code: "CON", name: "Cones" },
  { code: "CNX", name: "Connex" },
  { code: "CNT", name: "Container" },
  { code: "CND", name: "Container, Engine" },
  { code: "CNA", name: "Container, Household Goods, Wood" },
  { code: "CNB", name: "Container, Military Airlift" },
  { code: "CNF", name: "Container, Multiwall on Warehouse Pallet" },
  { code: "CNC", name: "Container, Navy Cargo" },
  { code: "CBC", name: "Containers of Bulk Cargo" },
  { code: "COR", name: "Core" },
  { code: "CRF", name: "Corner Reinforcement" },
  { code: "CRD", name: "Cradle" },
  { code: "CRT", name: "Crate" },
  { code: "CUB", name: "Cube" },
  { code: "CYL", name: "Cylinder" },
  { code: "DRK", name: "Double-length Rack" },
  { code: "DSK", name: "Double-length Skid" },
  { code: "DTB", name: "Double-length Tote Bin" },
  { code: "DRM", name: "Drum" },
  { code: "DBK", name: "Dry Bulk" },
  { code: "DUF", name: "Duffle Bag" },
  { code: "EPR", name: "Edge Protection" },
  { code: "EGG", name: "Egg Crating" },
  { code: "ENV", name: "Envelopes" },
  { code: "FIR", name: "Firkin" },
  { code: "FSK", name: "Flask" },
  { code: "FLO", name: "Flo-Bin" },
  { code: "FWR", name: "Forward Reel" },
  { code: "FRM", name: "Frame" },
  { code: "GOH", name: "Garments on Hangers" },
  { code: "HRK", name: "Half-Standard Rack" },
  { code: "HTB", name: "Half-Standard Tote Bin" },
  { code: "HPR", name: "Hamper" },
  { code: "HED", name: "Heads of Beef" },
  { code: "HGH", name: "Hogshead" },
  { code: "HPT", name: "Hopper Truck" },
  { code: "TLD", name: "Intermodal Trailer/Container Load (Rail)" },
  { code: "JAR", name: "Jar" },
  { code: "JUG", name: "Jug" },
  { code: "KEG", name: "Keg" },
  { code: "KIT", name: "Kit" },
  { code: "KRK", name: "Knockdown Rack" },
  { code: "KTB", name: "Knockdown Tote Bin" },
  { code: "LIF", name: "Lifts" },
  { code: "LVN", name: "Lift Van" },
  { code: "SBC", name: "Liner Bag Dry" },
  { code: "FLX", name: "Liner Bag Liquid" },
  { code: "LNR", name: "Liners" },
  { code: "LID", name: "Lip/Top" },
  { code: "LBK", name: "Liquid Bulk" },
  { code: "LOG", name: "Log" },
  { code: "LSE", name: "Loose" },
  { code: "LUG", name: "Lug" },
  { code: "MSV", name: "Military Sealift Command Van" },
  { code: "MLV", name: "Military Van" },
  { code: "MIX", name: "Mixed Container Types" },
  { code: "MXD", name: "Mixed Type Pack" },
  { code: "MRP", name: "Multi-Roll Pack" },
  { code: "NOL", name: "Noil" },
  { code: "HRB", name: "On Hanger or Rack in Boxes" },
  { code: "WHE", name: "On Own Wheel" },
  { code: "OVW", name: "Overwrap" },
  { code: "PKG", name: "Package" },
  { code: "PCK", name: "Packed - not otherwise specified" },
  { code: "PAL", name: "Pail" },
  { code: "PLT", name: "Pallet" },
  { code: "PAT", name: "Pallet - 2 Way" },
  { code: "PAF", name: "Pallet - 4 Way" },
  { code: "PRT", name: "Partitioning" },
  { code: "PCE", name: "Piece" },
  { code: "PCS", name: "Pieces" },
  { code: "PIR", name: "Pims" },
  { code: "PLN", name: "Pipeline" },
  { code: "PRK", name: "Pipe Rack" },
  { code: "PLF", name: "Platform" },
  { code: "PLC", name: "Primary Lift Container" },
  { code: "POV", name: "Private Vehicle" },
  { code: "QTR", name: "Quarter of Beef" },
  { code: "RCK", name: "Rack" },
  { code: "RAL", name: "Rail (Semiconductor)" },
  { code: "REL", name: "Reel" },
  { code: "RFT", name: "Reinforcement" },
  { code: "RVR", name: "Reverse Reel" },
  { code: "ROL", name: "Roll" },
  { code: "SAK", name: "Sack" },
  { code: "SVN", name: "Sea Van" },
  { code: "SPR", name: "Separator/Divider" },
  { code: "SHT", name: "Sheet" },
  { code: "SHK", name: "Shook" },
  { code: "SHW", name: "Shrink Wrapped" },
  { code: "SID", name: "Side of Beef" },
  { code: "SKD", name: "Skid" },
  { code: "SKE", name: "Skid, elevating or lift truck" },
  { code: "SLV", name: "Sleeve" },
  { code: "SLP", name: "Slip Sheet" },
  { code: "SPI", name: "Spin Cylinders" },
  { code: "SPL", name: "Spool" },
  { code: "SCS", name: "Suitcase" },
  { code: "TNK", name: "Tank" },
  { code: "TKR", name: "Tank Car" },
  { code: "TKT", name: "Tank Truck" },
  { code: "TRC", name: "Tierce" },
  { code: "TBN", name: "Tote Bin" },
  { code: "TTC", name: "Tote Can" },
  { code: "TRY", name: "Tray" },
  { code: "TRI", name: "Triwall Box" },
  { code: "TRU", name: "Truck" },
  { code: "TRK", name: "Trunk and Chest" },
  { code: "TSS", name: "Trunk, Salesmen Sample" },
  { code: "TUB", name: "Tub" },
  { code: "TBE", name: "Tube" },
  { code: "UNT", name: "Unit" },
  { code: "UNP", name: "Unpacked" },
  { code: "VPK", name: "Van Pack" },
  { code: "VEH", name: "Vehicles" },
  { code: "WLC", name: "Wheeled Carrier" },
  { code: "WRP", name: "Wrapped" },
] as const;

type PackagingEntry = { readonly code: string; readonly name: string };

function findPackagingCode(name: string, table: readonly PackagingEntry[]): string | undefined {
  const wanted = name.trim().toLowerCase();
  return table.find((row) => row.name.toLowerCase() === wanted)?.code;
}

/** Corridor's `commodities.packaging_type` (a CBP *name*, e.g. "Skid") → ACE packaging-unit code. */
export const findAcePackagingUnit = (name: string): string | undefined =>
  findPackagingCode(name, ACE_PACKAGING_UNITS);

/** Same, against the ACI list. */
export const findAciPackagingUnit = (name: string): string | undefined =>
  findPackagingCode(name, ACI_PACKAGING_UNITS);

// ---------------------------------------------------------------------------
// Source: https://borderconnect.com/data/us/ace/shipment-types.json
// ---------------------------------------------------------------------------
export const BC_ACE_SHIPMENT_TYPES = [
  { code: "PAPS", description: "PAPS" },
  { code: "IN_BOND", description: "Ace In-Bond" },
  { code: "QP_IN_BOND", description: "QP In-Bond" },
  { code: "GOODS_ASTRAY", description: "Goods Astray" },
  { code: "INTANGIBLES", description: "Intangibles" },
  { code: "ATTACHED_CF7523", description: "Free of Duty (Customs Form 7523)" },
  { code: "ATTACHED_CF3311", description: "Returned American Products (Customs Form 3311)" },
  { code: "ATTACHED_CF3299", description: "Personal Shipment (Customs Form 3299)" },
  { code: "CARNET", description: "Carnet" },
] as const;

/**
 * `ACE_SHIPMENT_TYPES` (packages/domain `movement-inputs.ts`) → BorderConnect
 * shipment-type code. Only these three are confirmed: the brief is explicit
 * that every other Corridor value (`section_321`, `free_of_duty_7523`,
 * `free_return_us_goods_3311`, `unaccounted_articles_3299`) 422s "until
 * confirmed" even though `BC_ACE_SHIPMENT_TYPES` above has entries that *look*
 * like plausible matches (`ATTACHED_CF7523`, `ATTACHED_CF3311`,
 * `ATTACHED_CF3299`) — those pairings are not confirmed against the manual,
 * so this map deliberately does not guess them.
 */
export const ACE_SHIPMENT_TYPE_MAP: Readonly<Partial<Record<string, string>>> = {
  regular_bill: "PAPS",
  goods_astray: "GOODS_ASTRAY",
  in_bond: "IN_BOND",
};

// ---------------------------------------------------------------------------
// Source: https://borderconnect.com/data/ca/aci/shipment-types.json
// ---------------------------------------------------------------------------
export const BC_ACI_SHIPMENT_TYPES = [
  { code: "PARS", description: "PARS" },
  { code: "CSA", description: "CSA" },
  { code: "BOND", description: "In-Bond" },
  { code: "E29B", description: "Temporary Admission Permit" },
  { code: "ATA", description: "ATA Carnet" },
  { code: "OIC", description: "Orders In Council" },
  { code: "PG", description: "Personal Goods" },
  { code: "A49", description: "A49 Automotive Release" },
  { code: "PAPER_RMD", description: "Paper RMD" },
  { code: "PAPER_B3", description: "Paper B3" },
  { code: "ASTRAY", description: "Goods Astray" },
  { code: "MILITARY", description: "Military Goods consigned to Dept of National Defence" },
  { code: "VI", description: "Value Included" },
  { code: "MP", description: "Master Provisional" },
  { code: "ALR", description: "Automotive Line Release" },
] as const;

// ---------------------------------------------------------------------------
// Source: https://borderconnect.com/data/operation-types.json
// ---------------------------------------------------------------------------
export const BC_OPERATION_TYPES = [
  { value: "UPDATE" },
  { value: "CREATE" },
  { value: "DELETE" },
  { value: "SYNC" },
  { value: "CANCEL_SYNC" },
] as const;

// ---------------------------------------------------------------------------
// Source: https://borderconnect.com/data/ca/aci/release-codes.json (Task 11 —
// the task brief's own `.../ca/rns/release-codes.json` 404s; this is the
// confirmed-live URL). CBSA's RNS message carries one of these under
// `rnsShipment.status.releaseCode.number` per the RNS Shipment JSON Reference
// Manual (`.../emanifest-api/manual/rns-shipment-json-reference.pdf`,
// section 1.11.2.1), whose own worked example is exactly code "4": "the
// goods are released by customs, and the carrier can proceed to deliver
// them to the consignee in Canada."
// ---------------------------------------------------------------------------
export const BC_ACI_RELEASE_CODES = [
  { number: "1", shortName: "Content Accepted", longName: "Message Content Accepted" },
  { number: "4", shortName: "Released", longName: "Goods Released" },
  {
    number: "5",
    shortName: "Examination Required",
    longName: "Goods required for examination - referred",
  },
  {
    number: "8",
    shortName: "Released (CFIA)",
    longName: "Customs Release, But Hold at Destination for CFIA",
  },
  {
    number: "9",
    shortName: "Declaration Accepted",
    longName: "Declaration Accepted, Awaiting arrival of goods",
  },
  { number: "14", shortName: "Error", longName: "Error message" },
  {
    number: "23",
    shortName: "CSA Authorized Delivery",
    longName: "Authorised to Deliver - CSA Shipment",
  },
  {
    number: "24",
    shortName: "Awaiting CBSA Processing",
    longName: "Declaration Accepted, Awaiting Customs Processing",
  },
  {
    number: "34",
    shortName: "Awaiting CBSA Processing",
    longName: "Declaration Accepted, Awaiting CBSA Processing",
  },
] as const;

/**
 * The subset of `BC_ACI_RELEASE_CODES` that mean customs itself released the
 * goods, for the purpose of stamping `shipments.status = "released"`.
 *
 *  - `4` "Released" is unambiguous (the manual's own example).
 *  - `8` "Released (CFIA)" is included too: its `longName` reads "Customs
 *    Release, But Hold at Destination for CFIA" — customs already released
 *    the goods; the hold is a downstream CFIA logistics matter at the
 *    destination, not a customs-status one. (Judgment call — flagged in the
 *    task report; the manual's own text doesn't spell out code 8 beyond the
 *    release-codes.json wording quoted above.)
 *
 * Every other code (`1`, `5`, `9`, `14`, `23`, `24`, `34`) is either
 * acknowledgement, a hold, an error, or still pending — none of them mean
 * the goods are clear to move.
 */
const RELEASING_ACI_CODES: ReadonlySet<string> = new Set(["4", "8"]);

/** Does this CBSA RNS release code mean customs released the goods? */
export function isAciReleaseCode(releaseCode: string | null | undefined): boolean {
  return !!releaseCode && RELEASING_ACI_CODES.has(releaseCode);
}
