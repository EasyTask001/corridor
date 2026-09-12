import { z } from "zod";
import { email, isoDate, isoDateTime, nonEmpty, uuid } from "./common";
import { equipmentType } from "./reference";

export const registryStatus = z.enum(["active", "inactive", "archived"]);
export type RegistryStatus = z.infer<typeof registryStatus>;

/** ISO 3166-2 style 2-letter state/province code, e.g. ON, BC, MI, NY. */
export const jurisdiction = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Use a 2-letter state/province code");

export const countryCode2 = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Use a 2-letter country code");

export const vin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-HJ-NPR-Z0-9]{17}$/, "VIN must be 17 characters (no I, O, Q)");

const optionalDate = isoDate.nullable().optional();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** Free-form postal address — shared by partners, drivers and shipments. */
export const address = z.object({
  line1: z.string().trim().max(120).optional(),
  line2: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  region: z.string().trim().max(40).optional(),
  postalCode: z.string().trim().max(20).optional(),
  country: countryCode2.optional(),
});
export type Address = z.infer<typeof address>;

/** The six parts of an address, in column order (0042). */
export const ADDRESS_PARTS = ["line1", "line2", "city", "region", "postalCode", "country"] as const;
export type AddressPart = (typeof ADDRESS_PARTS)[number];

/** Flat column keys an address occupies on a row: `AddressColumns<"billing">` = { billingLine1, …, billingCountry }. */
export type AddressColumns<P extends string> = {
  [K in AddressPart as `${P}${Capitalize<K>}`]: string | null;
};

export function addressColumnKey<P extends string, K extends AddressPart>(
  prefix: P,
  part: K,
): `${P}${Capitalize<K>}` {
  return `${prefix}${part.charAt(0).toUpperCase()}${part.slice(1)}` as `${P}${Capitalize<K>}`;
}
export function addressColumnKeys<P extends string>(prefix: P): Array<keyof AddressColumns<P>> {
  return ADDRESS_PARTS.map((part) => addressColumnKey(prefix, part)) as Array<
    keyof AddressColumns<P>
  >;
}

/** Flatten an API address onto a row. Blanks → null; country trimmed + upper-cased for the `^[A-Z]{2}$` check; null/undefined clears every part. */
export function addressToColumns<P extends string>(
  prefix: P,
  a: Address | null | undefined,
): AddressColumns<P> {
  const out: Record<string, string | null> = {};
  for (const part of ADDRESS_PARTS) {
    const raw = a?.[part];
    const value = typeof raw === "string" ? raw.trim() : "";
    out[addressColumnKey(prefix, part)] =
      value === "" ? null : part === "country" ? value.toUpperCase() : value;
  }
  return out as AddressColumns<P>;
}

/** The inverse: null / blank columns are omitted, so an empty address is `{}`. */
export function addressFromColumns<P extends string>(
  prefix: P,
  row: Partial<AddressColumns<P>>,
): Address {
  const out: Address = {};
  for (const part of ADDRESS_PARTS) {
    const value = (row as Record<string, unknown>)[addressColumnKey(prefix, part)];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    out[part] = part === "country" ? trimmed.toUpperCase() : trimmed;
  }
  return out;
}

/** A row with its flat address columns replaced by one nested `key`: `nestAddress("billing", "billingAddress", org)`. */
export function nestAddress<P extends string, K extends string, R extends AddressColumns<P>>(
  prefix: P,
  key: K,
  row: R,
): Omit<R, keyof AddressColumns<P>> & { [k in K]: Address } {
  const rest: Record<string, unknown> = { ...row };
  for (const k of addressColumnKeys(prefix)) delete rest[k as string];
  return { ...rest, [key]: addressFromColumns(prefix, row) } as Omit<R, keyof AddressColumns<P>> & {
    [k in K]: Address;
  };
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/** A person the carrier declares in the cab: one drives, the other rides. */
export const PERSON_TYPES = ["driver", "passenger"] as const;
export const personType = z.enum(PERSON_TYPES);
export type PersonType = z.infer<typeof personType>;

/** As CBP/CBSA record it on a crew list. */
export const GENDERS = ["M", "F", "X"] as const;
export const gender = z.enum(GENDERS);
export type Gender = z.infer<typeof gender>;

/**
 * Licence number/jurisdiction are optional here because a passenger has
 * neither; `drivers_license_required_check` (migration 0020) is what makes them
 * mandatory for anyone whose person type is `driver`.
 */
export const driverInput = z.object({
  firstName: nonEmpty.max(80),
  lastName: nonEmpty.max(80),
  personType: personType.default("driver"),
  licenseNumber: optionalText(40),
  licenseJurisdiction: jurisdiction.nullable().optional(),
  licenseExpiry: optionalDate,
  medicalCertExpiry: optionalDate,
  dateOfBirth: optionalDate,
  citizenship: countryCode2.nullable().optional(),
  gender: gender.nullable().optional(),
  hazmatEndorsement: z.boolean().default(false),
  /** US destination address CBP asks for from a non-US crew member. */
  usAddress: address.default({}),
  phone: optionalText(40),
  email: email.nullable().optional(),
  // 0025 — SMS entry-number notices, one phone per regime; e-mail the sheet.
  smsOptIn: z.boolean().default(false),
  smsPhoneAce: optionalText(40),
  smsPhoneAci: optionalText(40),
  emailDriverSheet: z.boolean().default(true),
  status: registryStatus.default("active"),
  notes: optionalText(2000),
});
export type DriverInput = z.infer<typeof driverInput>;

export const driverSchema = driverInput.extend({
  id: uuid,
  organizationId: uuid,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Driver = z.infer<typeof driverSchema>;

// ---------------------------------------------------------------------------
// Driver travel documents (CBP/CBSA WHTI list)
// ---------------------------------------------------------------------------

export const DRIVER_DOCUMENT_TYPES = [
  "passport",
  "us_passport_card",
  "fast",
  "nexus",
  "sentri",
  "enhanced_drivers_license",
  "permanent_resident_card",
  "us_alien_registration",
  "visa_immigrant",
  "visa_non_immigrant",
  "laser_visa_bcc",
  "military_id",
  "merchant_mariner",
  "native_american_inac",
  "dhs_reentry_permit",
  "dhs_refugee_travel",
  "birth_certificate",
  "citizenship_card",
  "certificate_of_naturalization",
  "other",
] as const;
export const driverDocumentType = z.enum(DRIVER_DOCUMENT_TYPES);
export type DriverDocumentType = z.infer<typeof driverDocumentType>;

/** Printable labels — shared by the registry UI and the compliance scanner. */
export const DRIVER_DOCUMENT_LABELS: Record<DriverDocumentType, string> = {
  passport: "Passport",
  us_passport_card: "US passport card",
  fast: "FAST card",
  nexus: "NEXUS card",
  sentri: "SENTRI card",
  enhanced_drivers_license: "Enhanced driver's licence",
  permanent_resident_card: "Permanent resident card",
  us_alien_registration: "US alien registration",
  visa_immigrant: "Immigrant visa",
  visa_non_immigrant: "Non-immigrant visa",
  laser_visa_bcc: "Laser visa / BCC",
  military_id: "Military ID",
  merchant_mariner: "Merchant mariner document",
  native_american_inac: "Native American / INAC card",
  dhs_reentry_permit: "DHS re-entry permit",
  dhs_refugee_travel: "DHS refugee travel document",
  birth_certificate: "Birth certificate",
  citizenship_card: "Citizenship card",
  certificate_of_naturalization: "Certificate of naturalization",
  other: "Other document",
};

export const driverDocumentInput = z.object({
  /** Present = update that row, absent = insert a new one. */
  id: uuid.optional(),
  driverId: uuid,
  documentType: driverDocumentType,
  documentNumber: nonEmpty.max(40),
  issuingCountry: countryCode2.nullable().optional(),
  issuingState: optionalText(40),
  issuedOn: optionalDate,
  expiresOn: optionalDate,
  isPrimary: z.boolean().default(false),
});
export type DriverDocumentInput = z.infer<typeof driverDocumentInput>;

export const driverDocumentRemoveInput = z.object({ driverId: uuid, id: uuid });

// ---------------------------------------------------------------------------
// Extra licence plates (equipment_plates, migration 0021)
// ---------------------------------------------------------------------------

/** One additional plate on a truck or trailer; the primary plate is on the unit. */
export const plateEntry = z.object({
  plateNumber: nonEmpty.max(20).toUpperCase(),
  jurisdiction,
});
export type PlateEntry = z.infer<typeof plateEntry>;

/** Up to three extra plates (four positions counting the primary). */
export const extraPlates = z.array(plateEntry).max(3).default([]);

// ---------------------------------------------------------------------------
// Trucks
// ---------------------------------------------------------------------------

export const truckInput = z.object({
  unitNumber: nonEmpty.max(40),
  vin: vin.nullable().optional(),
  make: optionalText(60),
  model: optionalText(60),
  modelYear: z.number().int().min(1950).max(2100).nullable().optional(),
  plateNumber: nonEmpty.max(20),
  plateJurisdiction: jurisdiction,
  registrationExpiry: optionalDate,
  insurancePolicyNumber: optionalText(60),
  insuranceExpiry: optionalDate,
  annualInspectionExpiry: optionalDate,
  transponderNumber: optionalText(40),
  dotNumber: z
    .string()
    .trim()
    .regex(/^\d{1,8}$/, "US DOT number is 1-8 digits")
    .nullable()
    .optional(),
  hazmatCapable: z.boolean().default(false),
  insuranceCompany: optionalText(120),
  insuranceAmount: z.number().min(0).max(9_999_999_999).nullable().optional(),
  insuranceYear: z.number().int().min(1990).max(2100).nullable().optional(),
  extraPlates,
  status: registryStatus.default("active"),
  notes: optionalText(2000),
});
export type TruckInput = z.infer<typeof truckInput>;

export const truckSchema = truckInput.extend({
  id: uuid,
  organizationId: uuid,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Truck = z.infer<typeof truckSchema>;

// ---------------------------------------------------------------------------
// Trailers
// ---------------------------------------------------------------------------

/** A CBP equipment description code (equipment_types, migration 0021). */
export const trailerType = equipmentType;
export type TrailerType = z.infer<typeof trailerType>;

export const trailerInput = z.object({
  unitNumber: nonEmpty.max(40),
  vin: vin.nullable().optional(),
  trailerType: trailerType.default("TF"),
  plateNumber: nonEmpty.max(20),
  plateJurisdiction: jurisdiction,
  registrationExpiry: optionalDate,
  insuranceExpiry: optionalDate,
  annualInspectionExpiry: optionalDate,
  lengthFt: z.number().positive().max(100).nullable().optional(),
  extraPlates,
  status: registryStatus.default("active"),
  notes: optionalText(2000),
});
export type TrailerInput = z.infer<typeof trailerInput>;

export const trailerSchema = trailerInput.extend({
  id: uuid,
  organizationId: uuid,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Trailer = z.infer<typeof trailerSchema>;

// ---------------------------------------------------------------------------
// Partners (shipper / consignee / broker)
// ---------------------------------------------------------------------------

export const partnerType = z.enum(["shipper", "consignee", "broker", "both"]);
export type PartnerType = z.infer<typeof partnerType>;

export const partnerInput = z.object({
  name: nonEmpty.max(160),
  type: partnerType,
  /** A partner's country decides which side of an ACE / ACI shipment it is offered for. */
  address: address.extend({ country: countryCode2 }),
  taxId: optionalText(40),
  contactName: optionalText(120),
  contactEmail: email.nullable().optional(),
  contactPhone: optionalText(40),
  status: registryStatus.default("active"),
  notes: optionalText(2000),
});
export type PartnerInput = z.infer<typeof partnerInput>;

export const partnerSchema = partnerInput.extend({
  id: uuid,
  organizationId: uuid,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Partner = z.infer<typeof partnerSchema>;

// ---------------------------------------------------------------------------
// Shared list query
// ---------------------------------------------------------------------------

/** Columns each registry can search in one at a time (Task 14); keys are row fields. */
export const REGISTRY_SEARCH_COLUMNS = {
  drivers: [
    { key: "lastName", label: "Last name" },
    { key: "firstName", label: "First name" },
    { key: "licenseNumber", label: "License #" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
  ],
  trucks: [
    { key: "unitNumber", label: "Unit" },
    { key: "vin", label: "VIN" },
    { key: "plateNumber", label: "Plate" },
    { key: "make", label: "Make" },
  ],
  trailers: [
    { key: "unitNumber", label: "Unit" },
    { key: "vin", label: "VIN" },
    { key: "plateNumber", label: "Plate" },
  ],
  partners: [
    { key: "name", label: "Name" },
    { key: "contactName", label: "Contact" },
    { key: "taxId", label: "Tax ID" },
    { key: "contactEmail", label: "Contact email" },
  ],
} as const satisfies Record<string, ReadonlyArray<{ key: string; label: string }>>;
export type RegistrySearchColumn =
  (typeof REGISTRY_SEARCH_COLUMNS)[keyof typeof REGISTRY_SEARCH_COLUMNS][number]["key"];

export const registryListInput = z.object({
  search: z.string().trim().max(100).optional(),
  /** Restrict `search` to one of that registry's columns; the API rejects a column it does not know. */
  searchColumn: z.string().trim().max(40).optional(),
  /** Rows per page; wins over `limit` when both are sent. */
  pageSize: z.number().int().min(10).max(200).optional(),
  /** Partners only: the side of a shipment they can take (`both` always qualifies). */
  direction: z.enum(["shipper", "consignee"]).optional(),
  status: registryStatus.optional(),
  includeArchived: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type RegistryListInput = z.infer<typeof registryListInput>;

/** Bulk activate / deactivate / archive from the list (Task 14). */
export const registryBulkStatusInput = z.object({
  ids: z.array(uuid).min(1).max(200),
  status: registryStatus,
});
export type RegistryBulkStatusInput = z.infer<typeof registryBulkStatusInput>;

/** A partner's side of a shipment, for pre-filtering the pickers. */
export const partnerDirection = z.enum(["shipper", "consignee"]);
export type PartnerDirection = z.infer<typeof partnerDirection>;

/**
 * Which country a shipper / consignee is normally in for a regime: an ACE
 * (US-bound) load is picked up in Canada and delivered in the US; ACI the
 * reverse. The form pre-filters on this and offers an override.
 */
export const expectedPartnerCountry = (regime: "ACE" | "ACI", direction: PartnerDirection) =>
  (regime === "ACE") === (direction === "shipper") ? "CA" : "US";
