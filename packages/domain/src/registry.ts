import { z } from "zod";
import { email, isoDate, isoDateTime, nonEmpty, uuid } from "./common";

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

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export const driverInput = z.object({
  firstName: nonEmpty.max(80),
  lastName: nonEmpty.max(80),
  licenseNumber: nonEmpty.max(40),
  licenseJurisdiction: jurisdiction,
  licenseExpiry: optionalDate,
  fastCardNumber: optionalText(40),
  fastCardExpiry: optionalDate,
  medicalCertExpiry: optionalDate,
  dateOfBirth: optionalDate,
  citizenship: countryCode2.nullable().optional(),
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

export const trailerType = z.enum([
  "dry_van",
  "reefer",
  "flatbed",
  "tanker",
  "container_chassis",
  "step_deck",
  "other",
]);
export type TrailerType = z.infer<typeof trailerType>;

export const trailerInput = z.object({
  unitNumber: nonEmpty.max(40),
  vin: vin.nullable().optional(),
  trailerType: trailerType.default("dry_van"),
  plateNumber: nonEmpty.max(20),
  plateJurisdiction: jurisdiction,
  registrationExpiry: optionalDate,
  insuranceExpiry: optionalDate,
  annualInspectionExpiry: optionalDate,
  lengthFt: z.number().positive().max(100).nullable().optional(),
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

export const address = z.object({
  line1: z.string().trim().max(120).optional(),
  line2: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  region: z.string().trim().max(40).optional(),
  postalCode: z.string().trim().max(20).optional(),
  country: countryCode2.optional(),
});
export type Address = z.infer<typeof address>;

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
