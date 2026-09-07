import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { ACE_SHIPMENT_TYPES, ACI_CARGO_TYPES } from "@corridor/domain";
import type { MovementSuggestionPayload } from "@corridor/domain";
import { authUsers, organizations } from "./core";
import { sourceDocuments } from "./documents";
import { ports } from "./reference";
import { drivers, partners, trailers, trucks } from "./registry";

/**
 * Per-organization sequence counters behind next_movement_number(). No RLS
 * policy exists for it on purpose — only that SECURITY DEFINER function writes
 * here — but it is mirrored so the Drizzle schema matches the migrations.
 */
export const organizationCounters = pgTable(
  "organization_counters",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.key] })],
);

export const MOVEMENT_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "released",
  "held",
  "arrived",
  "cancelled",
] as const;

export const movements = pgTable(
  "movements",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    regime: text("regime", { enum: ["ACE", "ACI"] }).notNull(),
    movementNumber: text("movement_number").notNull(),
    tripNumber: text("trip_number"),
    status: text("status", { enum: MOVEMENT_STATUSES }).notNull().default("draft"),
    portId: uuid("port_id").references(() => ports.id),
    /** Snapshot of the org's carrier code at the time it was set — not an FK,
     * see migration 0018: the control number is built from this text and
     * must not move if the org edits its codes later. */
    carrierCode: text("carrier_code"),
    scheduledCrossingAt: timestamp("scheduled_crossing_at", { withTimezone: true }),
    driverId: uuid("driver_id").references(() => drivers.id, { onDelete: "restrict" }),
    truckId: uuid("truck_id").references(() => trucks.id, { onDelete: "restrict" }),
    trailerId: uuid("trailer_id").references(() => trailers.id, { onDelete: "restrict" }),
    customsReferenceNumber: text("customs_reference_number"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("movements_organization_id_idx").on(t.organizationId),
    index("movements_org_status_idx").on(t.organizationId, t.status),
    index("movements_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    index("movements_org_scheduled_idx").on(t.organizationId, t.scheduledCrossingAt),
    index("movements_driver_idx")
      .on(t.driverId)
      .where(sql`${t.driverId} is not null`),
    index("movements_truck_idx")
      .on(t.truckId)
      .where(sql`${t.truckId} is not null`),
    index("movements_trailer_idx")
      .on(t.trailerId)
      .where(sql`${t.trailerId} is not null`),
    index("movements_port_idx")
      .on(t.portId)
      .where(sql`${t.portId} is not null`),
    unique("movements_organization_id_movement_number_key").on(t.organizationId, t.movementNumber),
  ],
);

export const movementSuggestions = pgTable(
  "movement_suggestions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    movementId: uuid("movement_id")
      .notNull()
      .references(() => movements.id, { onDelete: "cascade" }),
    sourceMovementId: uuid("source_movement_id")
      .notNull()
      .references(() => movements.id, { onDelete: "cascade" }),
    score: numeric("score", { precision: 5, scale: 2, mode: "number" }).notNull(),
    reasons: text("reasons").array().notNull(),
    suggestedPayload: jsonb("suggested_payload").$type<MovementSuggestionPayload>().notNull(),
    status: text("status", { enum: ["offered", "accepted", "dismissed"] })
      .notNull()
      .default("offered"),
    createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("movement_suggestions_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    index("movement_suggestions_movement_idx").on(t.movementId, t.createdAt.desc()),
  ],
);

export const movementEvents = pgTable(
  "movement_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    movementId: uuid("movement_id")
      .notNull()
      .references(() => movements.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** 0019 — the shipment this row is about, when it is about one. */
    shipmentId: uuid("shipment_id").references((): AnyPgColumn => shipments.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type", {
      enum: ["status_change", "amendment", "note", "customs_response", "ai_flag"],
    }).notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    actorType: text("actor_type", { enum: ["user", "system", "customs_api", "ai"] }).notNull(),
    actorId: uuid("actor_id").references(() => authUsers.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("movement_events_movement_idx").on(t.movementId, t.occurredAt),
    index("movement_events_org_idx").on(t.organizationId, t.occurredAt.desc()),
  ],
);

export const movementAmendments = pgTable(
  "movement_amendments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    movementId: uuid("movement_id")
      .notNull()
      .references(() => movements.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    amendmentNumber: integer("amendment_number").notNull(),
    reason: text("reason").notNull(),
    diff: jsonb("diff")
      .$type<Record<string, { before: unknown; after: unknown }>>()
      .notNull()
      .default({}),
    status: text("status", { enum: ["draft", "submitted", "accepted", "rejected"] })
      .notNull()
      .default("submitted"),
    createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("movement_amendments_movement_idx").on(t.movementId),
    unique("movement_amendments_movement_id_amendment_number_key").on(
      t.movementId,
      t.amendmentNumber,
    ),
    // 0011
    index("movement_amendments_organization_id_idx").on(t.organizationId),
  ],
);

export const SHIPMENT_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "entry_on_file",
  "released",
  "held",
  "arrived",
  "cancelled",
] as const;

export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    regime: text("regime", { enum: ["ACE", "ACI"] }).notNull(),
    /** Null while the shipment is waiting to be put on a trip. */
    movementId: uuid("movement_id").references(() => movements.id, { onDelete: "set null" }),
    carrierCode: text("carrier_code").notNull(),
    shipmentType: text("shipment_type", { enum: ACE_SHIPMENT_TYPES }),
    cargoType: text("cargo_type", { enum: ACI_CARGO_TYPES }),
    controlReference: text("control_reference").notNull(),
    /** Denormalised `carrier_code || control_reference`, kept by the
     * shipments_control_number() trigger — never written by application code. */
    controlNumber: text("control_number").notNull().default(""),
    isPars: boolean("is_pars").notNull().default(false),
    entryNumber: text("entry_number"),
    entryPortId: uuid("entry_port_id").references(() => ports.id),
    inBondEntryType: text("in_bond_entry_type", { enum: ["IT", "TE", "IE"] }),
    inBondDestinationPortId: uuid("in_bond_destination_port_id").references(() => ports.id),
    inBondNumber: text("in_bond_number"),
    shipperId: uuid("shipper_id").references(() => partners.id, { onDelete: "restrict" }),
    consigneeId: uuid("consignee_id").references(() => partners.id, { onDelete: "restrict" }),
    destinationPortId: uuid("destination_port_id").references(() => ports.id),
    sublocationPortId: uuid("sublocation_port_id").references(() => ports.id),
    loadingCountry: text("loading_country"),
    loadingProvince: text("loading_province"),
    loadingCity: text("loading_city"),
    deliveryAddress: jsonb("delivery_address")
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
    consigneeBusinessNumber: text("consignee_business_number"),
    status: text("status", { enum: SHIPMENT_STATUSES }).notNull().default("draft"),
    entryOnFileAt: timestamp("entry_on_file_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** FK added in Task 11 with the import_batches table. */
    importBatchId: uuid("import_batch_id"),
    sourceDocumentId: uuid("source_document_id").references((): AnyPgColumn => sourceDocuments.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("shipments_organization_id_idx").on(t.organizationId),
    index("shipments_org_status_idx").on(t.organizationId, t.status),
    index("shipments_movement_idx")
      .on(t.movementId)
      .where(sql`${t.movementId} is not null`),
    index("shipments_control_search_idx").using(
      "gin",
      sql`to_tsvector('simple', ${t.controlNumber})`,
    ),
    unique("shipments_organization_id_control_number_key").on(t.organizationId, t.controlNumber),
  ],
);

/** 0019 — `cargo`, renamed and re-parented onto the shipment. */
export const commodities = pgTable(
  "commodities",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull().default(1),
    commodityDescription: text("commodity_description").notNull(),
    hsCode: text("hs_code"),
    /** Canonical weight; `weightUnit` records what the user typed. */
    weightKg: numeric("weight_kg", { precision: 12, scale: 2, mode: "number" }),
    weightUnit: text("weight_unit", { enum: ["KG", "LB"] })
      .notNull()
      .default("KG"),
    quantity: integer("quantity"),
    quantityUnit: text("quantity_unit"),
    packagingType: text("packaging_type"),
    marksAndNumbers: text("marks_and_numbers"),
    isConsolidated: boolean("is_consolidated").notNull().default(false),
    valueAmount: numeric("value_amount", { precision: 14, scale: 2, mode: "number" }),
    valueCurrency: text("value_currency", { enum: ["USD", "CAD"] }),
    countryOfOrigin: text("country_of_origin"),
    sourceDocumentId: uuid("source_document_id").references((): AnyPgColumn => sourceDocuments.id, {
      onDelete: "set null",
    }),
    extractionConfidence: numeric("extraction_confidence", {
      precision: 4,
      scale: 3,
      mode: "number",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("commodities_shipment_idx").on(t.shipmentId, t.lineNumber),
    index("commodities_organization_id_idx").on(t.organizationId),
    index("commodities_commodity_search_idx").using(
      "gin",
      sql`to_tsvector('simple', ${t.commodityDescription})`,
    ),
  ],
);

/** Up to three dangerous-goods declarations per commodity line. */
export const commodityHazmat = pgTable(
  "commodity_hazmat",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    commodityId: uuid("commodity_id")
      .notNull()
      .references(() => commodities.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    unCode: text("un_code").notNull(),
    description: text("description"),
    emergencyContact: text("emergency_contact"),
    emergencyPhone: text("emergency_phone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("commodity_hazmat_organization_id_idx").on(t.organizationId),
    unique("commodity_hazmat_commodity_id_position_key").on(t.commodityId, t.position),
  ],
);

export const seals = pgTable(
  "seals",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    movementId: uuid("movement_id")
      .notNull()
      .references(() => movements.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    trailerId: uuid("trailer_id").references(() => trailers.id, { onDelete: "set null" }),
    sealNumber: text("seal_number").notNull(),
    sealType: text("seal_type"),
    appliedBy: text("applied_by"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("seals_movement_idx").on(t.movementId),
    uniqueIndex("seals_movement_number_unique").on(t.movementId, t.sealNumber),
    // 0011
    index("seals_organization_id_idx").on(t.organizationId),
  ],
);
