import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { DRIVER_DOCUMENT_TYPES, GENDERS, PERSON_TYPES } from "@corridor/domain";
import type { Address } from "@corridor/domain";
import { authUsers, citext, organizations } from "./core";

const registryStatus = ["active", "inactive", "archived"] as const;

const base = () => ({
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  status: text("status", { enum: registryStatus }).notNull().default("active"),
  notes: text("notes"),
  createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const drivers = pgTable(
  "drivers",
  {
    ...base(),
    userId: uuid("user_id").references(() => authUsers.id, { onDelete: "set null" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    /** Null only for a passenger — see drivers_license_required_check (0020). */
    licenseNumber: text("license_number"),
    licenseJurisdiction: text("license_jurisdiction"),
    licenseExpiry: date("license_expiry"),
    medicalCertExpiry: date("medical_cert_expiry"),
    dateOfBirth: date("date_of_birth"),
    citizenship: text("citizenship"),
    phone: text("phone"),
    email: citext("email"),
    // 0020
    personType: text("person_type", { enum: PERSON_TYPES }).notNull().default("driver"),
    gender: text("gender", { enum: GENDERS }),
    hazmatEndorsement: boolean("hazmat_endorsement").notNull().default(false),
    usAddress: jsonb("us_address").$type<Address>().notNull().default({}),
  },
  (t) => [
    index("drivers_organization_id_idx").on(t.organizationId),
    index("drivers_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    index("drivers_org_status_idx").on(t.organizationId, t.status),
    uniqueIndex("drivers_org_license_unique")
      .on(t.organizationId, t.licenseJurisdiction, t.licenseNumber)
      .where(sql`${t.status} <> 'archived'`),
    index("drivers_name_search_idx").using(
      "gin",
      sql`to_tsvector('simple', ${t.firstName} || ' ' || ${t.lastName})`,
    ),
    uniqueIndex("drivers_org_user_unique")
      .on(t.organizationId, t.userId)
      .where(sql`${t.userId} is not null`),
    /** 0020 — target for the composite (id, organization_id) keys on
     * movement_crew and driver_documents. */
    unique("drivers_id_organization_id_key").on(t.id, t.organizationId),
  ],
);

/** 0020 — the passport / FAST / NEXUS / visa documents one person travels on. */
export const driverDocuments = pgTable(
  "driver_documents",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** FK is composite — see driver_documents_driver_id_fkey below. */
    driverId: uuid("driver_id").notNull(),
    documentType: text("document_type", { enum: DRIVER_DOCUMENT_TYPES }).notNull(),
    documentNumber: text("document_number").notNull(),
    issuingCountry: text("issuing_country"),
    issuingState: text("issuing_state"),
    issuedOn: date("issued_on"),
    expiresOn: date("expires_on"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("driver_documents_organization_id_idx").on(t.organizationId),
    index("driver_documents_driver_idx").on(t.driverId, t.documentType),
    unique("driver_documents_driver_id_document_type_document_number_key").on(
      t.driverId,
      t.documentType,
      t.documentNumber,
    ),
    foreignKey({
      name: "driver_documents_driver_id_fkey",
      columns: [t.driverId, t.organizationId],
      foreignColumns: [drivers.id, drivers.organizationId],
    }).onDelete("cascade"),
  ],
);

export const trucks = pgTable(
  "trucks",
  {
    ...base(),
    unitNumber: text("unit_number").notNull(),
    vin: text("vin"),
    make: text("make"),
    model: text("model"),
    modelYear: smallint("model_year"),
    plateNumber: text("plate_number").notNull(),
    plateJurisdiction: text("plate_jurisdiction").notNull(),
    registrationExpiry: date("registration_expiry"),
    insurancePolicyNumber: text("insurance_policy_number"),
    insuranceExpiry: date("insurance_expiry"),
    annualInspectionExpiry: date("annual_inspection_expiry"),
    transponderNumber: text("transponder_number"),
  },
  (t) => [
    index("trucks_organization_id_idx").on(t.organizationId),
    index("trucks_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    uniqueIndex("trucks_org_unit_unique")
      .on(t.organizationId, t.unitNumber)
      .where(sql`${t.status} <> 'archived'`),
    uniqueIndex("trucks_org_vin_unique")
      .on(t.organizationId, t.vin)
      .where(sql`${t.vin} is not null and ${t.status} <> 'archived'`),
  ],
);

export const trailers = pgTable(
  "trailers",
  {
    ...base(),
    unitNumber: text("unit_number").notNull(),
    vin: text("vin"),
    trailerType: text("trailer_type", {
      enum: ["dry_van", "reefer", "flatbed", "tanker", "container_chassis", "step_deck", "other"],
    })
      .notNull()
      .default("dry_van"),
    plateNumber: text("plate_number").notNull(),
    plateJurisdiction: text("plate_jurisdiction").notNull(),
    registrationExpiry: date("registration_expiry"),
    insuranceExpiry: date("insurance_expiry"),
    annualInspectionExpiry: date("annual_inspection_expiry"),
    lengthFt: numeric("length_ft", { precision: 5, scale: 1, mode: "number" }),
  },
  (t) => [
    index("trailers_organization_id_idx").on(t.organizationId),
    index("trailers_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    uniqueIndex("trailers_org_unit_unique")
      .on(t.organizationId, t.unitNumber)
      .where(sql`${t.status} <> 'archived'`),
  ],
);

export const partners = pgTable(
  "partners",
  {
    ...base(),
    name: text("name").notNull(),
    type: text("type", { enum: ["shipper", "consignee", "broker", "both"] }).notNull(),
    address: jsonb("address")
      .$type<{
        line1?: string;
        line2?: string;
        city?: string;
        region?: string;
        postalCode?: string;
        country?: string;
      }>()
      .notNull()
      .default({}),
    taxId: text("tax_id"),
    contactName: text("contact_name"),
    contactEmail: citext("contact_email"),
    contactPhone: text("contact_phone"),
  },
  (t) => [
    index("partners_organization_id_idx").on(t.organizationId),
    index("partners_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    index("partners_org_type_idx").on(t.organizationId, t.type),
    index("partners_name_search_idx").using("gin", sql`to_tsvector('simple', ${t.name})`),
  ],
);
