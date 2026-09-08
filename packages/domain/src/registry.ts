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
  address: address.default({}),
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

export const registryListInput = z.object({
  search: z.string().trim().max(100).optional(),
  status: registryStatus.optional(),
  includeArchived: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type RegistryListInput = z.infer<typeof registryListInput>;
