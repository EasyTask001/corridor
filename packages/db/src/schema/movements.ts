import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
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
} from "drizzle-orm/pg-core";
import {
  ACE_SHIPMENT_TYPES,
  ACI_CARGO_TYPES,
  CBSA_AMENDMENT_REASON_CODE_VALUES,
  CREW_ROLES,
  IIT_INDICATORS,
} from "@corridor/domain";
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
    /** FK is composite — see movements_truck_org_fkey below. */
    truckId: uuid("truck_id"),
    /** 0021 — "Empty Trailer" (ACE) / "Empty Trip" (ACI): no goods on board. */
    isEmpty: boolean("is_empty").notNull().default(false),
    // 0022 — manifest flags
    iitIndicator: text("iit_indicator", { enum: IIT_INDICATORS }).notNull().default("none"),
    aciLvs: boolean("aci_lvs").notNull().default(false),
    aciPostal: boolean("aci_postal").notNull().default(false),
    aciFlyingTruck: boolean("aci_flying_truck").notNull().default(false),
    aciInTransit: boolean("aci_in_transit").notNull().default(false),
    aciIit: boolean("aci_iit").notNull().default(false),
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
    index("movements_truck_idx")
      .on(t.truckId)
      .where(sql`${t.truckId} is not null`),
    index("movements_port_idx")
      .on(t.portId)
      .where(sql`${t.portId} is not null`),
    unique("movements_organization_id_movement_number_key").on(t.organizationId, t.movementNumber),
    // 0034
    index("movements_number_trgm_idx").using("gin", t.movementNumber),
    // 0043
    index("movements_trip_number_trgm_idx").using("gin", t.tripNumber),
    index("movements_customs_reference_trgm_idx").using("gin", t.customsReferenceNumber),
    // 0031
    index("movements_org_truck_idx")
      .on(t.organizationId, t.truckId)
      .where(sql`${t.truckId} is not null`),
    /** 0031 — target for the composite keys on movement_crew, movement_trailers,
     * movement_events, movement_amendments, movement_suggestions, seals,
     * integration_events, source_documents, shipments, customs_submissions,
     * generated_documents. */
    uniqueIndex("movements_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "movements_truck_org_fkey",
      columns: [t.truckId, t.organizationId],
      foreignColumns: [trucks.id, trucks.organizationId],
    }).onDelete("restrict"),
  ],
);

/**
 * 0020 — the people on one crossing. Replaces movements.driver_id: CBP/CBSA
 * accept a person in charge plus additional crew members and passengers, and
 * the role belongs to the pairing, not to the person.
 */
export const movementCrew = pgTable(
  "movement_crew",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** FK is composite — see movement_crew_movement_org_fkey below. */
    movementId: uuid("movement_id").notNull(),
    /** FK is composite — see movement_crew_driver_id_fkey below. */
    driverId: uuid("driver_id").notNull(),
    role: text("role", { enum: CREW_ROLES }).notNull().default("crew_member"),
    position: integer("position").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("movement_crew_organization_id_idx").on(t.organizationId),
    index("movement_crew_movement_idx").on(t.movementId, t.position),
    index("movement_crew_driver_idx").on(t.driverId),
    uniqueIndex("movement_crew_pic_unique")
      .on(t.movementId)
      .where(sql`${t.role} = 'person_in_charge'`),
    unique("movement_crew_movement_id_driver_id_key").on(t.movementId, t.driverId),
    // 0031
    index("movement_crew_org_movement_idx").on(t.organizationId, t.movementId),
    foreignKey({
      name: "movement_crew_driver_id_fkey",
      columns: [t.driverId, t.organizationId],
      foreignColumns: [drivers.id, drivers.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "movement_crew_movement_org_fkey",
      columns: [t.movementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("cascade"),
  ],
);

/**
 * 0021 — the trailers on one crossing, in tow order. Replaces
 * movements.trailer_id: a tractor pulls zero, one or two.
 */
export const movementTrailers = pgTable(
  "movement_trailers",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** FK is composite — see movement_trailers_movement_org_fkey below. */
    movementId: uuid("movement_id").notNull(),
    /** FK is composite — see movement_trailers_trailer_id_fkey below. */
    trailerId: uuid("trailer_id").notNull(),
    position: integer("position").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("movement_trailers_organization_id_idx").on(t.organizationId),
    index("movement_trailers_movement_idx").on(t.movementId, t.position),
    index("movement_trailers_trailer_idx").on(t.trailerId),
    unique("movement_trailers_movement_id_trailer_id_key").on(t.movementId, t.trailerId),
    // 0031
    index("movement_trailers_org_movement_idx").on(t.organizationId, t.movementId),
    /** 0031 — target for the composite key on seals. */
    uniqueIndex("movement_trailers_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "movement_trailers_trailer_id_fkey",
      columns: [t.trailerId, t.organizationId],
      foreignColumns: [trailers.id, trailers.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "movement_trailers_movement_org_fkey",
      columns: [t.movementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("cascade"),
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
    /** FK is composite — see movement_suggestions_movement_org_fkey below. */
    movementId: uuid("movement_id").notNull(),
    /** FK is composite — see movement_suggestions_source_movement_org_fkey below. */
    sourceMovementId: uuid("source_movement_id").notNull(),
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
    // 0031
    index("movement_suggestions_org_movement_idx").on(t.organizationId, t.movementId),
    index("movement_suggestions_org_source_movement_idx").on(t.organizationId, t.sourceMovementId),
    // 0031 — parent key, ready for a future composite FK onto this table.
    uniqueIndex("movement_suggestions_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "movement_suggestions_movement_org_fkey",
      columns: [t.movementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "movement_suggestions_source_movement_org_fkey",
      columns: [t.sourceMovementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("cascade"),
  ],
);

export const movementEvents = pgTable(
  "movement_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** FK is composite — see movement_events_movement_org_fkey below. */
    movementId: uuid("movement_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** 0019 — the shipment this row is about, when it is about one.
     * FK is composite — see movement_events_shipment_org_fkey below. */
    shipmentId: uuid("shipment_id"),
    eventType: text("event_type", {
      enum: ["status_change", "amendment", "note", "customs_response", "ai_flag", "customs_event"],
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
    // 0031
    index("movement_events_org_movement_idx").on(t.organizationId, t.movementId),
    index("movement_events_org_shipment_idx")
      .on(t.organizationId, t.shipmentId)
      .where(sql`${t.shipmentId} is not null`),
    // 0031 — parent key, ready for a future composite FK onto this table.
    uniqueIndex("movement_events_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "movement_events_movement_org_fkey",
      columns: [t.movementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "movement_events_shipment_org_fkey",
      columns: [t.shipmentId, t.organizationId],
      foreignColumns: [shipments.id, shipments.organizationId],
    }).onDelete("set null"),
  ],
);

export const movementAmendments = pgTable(
  "movement_amendments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** FK is composite — see movement_amendments_movement_org_fkey below. */
    movementId: uuid("movement_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    amendmentNumber: integer("amendment_number").notNull(),
    reason: text("reason").notNull(),
    /** 0022 — the shipment the amendment is about; null = the trip header.
     * FK is composite — see movement_amendments_shipment_org_fkey below. */
    shipmentId: uuid("shipment_id"),
    /** 0022 — CBSA ECCRD reason code, required on an ACI amendment (trigger). */
    reasonCode: text("reason_code", { enum: CBSA_AMENDMENT_REASON_CODE_VALUES }),
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
    // 0022
    index("movement_amendments_shipment_idx")
      .on(t.shipmentId)
      .where(sql`${t.shipmentId} is not null`),
    // 0031
    index("movement_amendments_org_movement_idx").on(t.organizationId, t.movementId),
    index("movement_amendments_org_shipment_idx")
      .on(t.organizationId, t.shipmentId)
      .where(sql`${t.shipmentId} is not null`),
    // 0031 — parent key, ready for a future composite FK onto this table.
    uniqueIndex("movement_amendments_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "movement_amendments_movement_org_fkey",
      columns: [t.movementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "movement_amendments_shipment_org_fkey",
      columns: [t.shipmentId, t.organizationId],
      foreignColumns: [shipments.id, shipments.organizationId],
    }).onDelete("set null"),
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
    /** Null while the shipment is waiting to be put on a trip.
     * FK is composite — see shipments_movement_org_fkey below. */
    movementId: uuid("movement_id"),
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
    /** FK is composite — see shipments_shipper_org_fkey below. */
    shipperId: uuid("shipper_id"),
    /** FK is composite — see shipments_consignee_org_fkey below. */
    consigneeId: uuid("consignee_id"),
    /** 0049 — shipment-specific customs broker; role is guarded in the database. */
    brokerId: uuid("broker_id"),
    destinationPortId: uuid("destination_port_id").references(() => ports.id),
    sublocationPortId: uuid("sublocation_port_id").references(() => ports.id),
    loadingCountry: text("loading_country"),
    loadingProvince: text("loading_province"),
    loadingCity: text("loading_city"),
    // 0042 — delivery_address as columns; the API nests them back as `deliveryAddress`.
    deliveryLine1: text("delivery_line1"),
    deliveryLine2: text("delivery_line2"),
    deliveryCity: text("delivery_city"),
    deliveryRegion: text("delivery_region"),
    deliveryPostalCode: text("delivery_postal_code"),
    deliveryCountry: text("delivery_country"),
    consigneeBusinessNumber: text("consignee_business_number"),
    status: text("status", { enum: SHIPMENT_STATUSES }).notNull().default("draft"),
    entryOnFileAt: timestamp("entry_on_file_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** 0028 — the CSV batch that created the row.
     * FK is composite — see shipments_import_batch_org_fkey below. */
    importBatchId: uuid("import_batch_id"),
    /** FK is composite — see shipments_source_document_org_fkey below. */
    sourceDocumentId: uuid("source_document_id"),
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
    // 0028
    index("shipments_import_batch_idx")
      .on(t.importBatchId)
      .where(sql`${t.importBatchId} is not null`),
    // 0034
    index("shipments_control_number_trgm_idx").using("gin", t.controlNumber),
    // 0031
    index("shipments_org_consignee_idx")
      .on(t.organizationId, t.consigneeId)
      .where(sql`${t.consigneeId} is not null`),
    index("shipments_org_broker_idx")
      .on(t.organizationId, t.brokerId)
      .where(sql`${t.brokerId} is not null`),
    index("shipments_org_import_batch_idx")
      .on(t.organizationId, t.importBatchId)
      .where(sql`${t.importBatchId} is not null`),
    index("shipments_org_movement_idx")
      .on(t.organizationId, t.movementId)
      .where(sql`${t.movementId} is not null`),
    index("shipments_org_shipper_idx")
      .on(t.organizationId, t.shipperId)
      .where(sql`${t.shipperId} is not null`),
    index("shipments_org_source_document_idx")
      .on(t.organizationId, t.sourceDocumentId)
      .where(sql`${t.sourceDocumentId} is not null`),
    // 0043
    index("shipments_entry_port_idx")
      .on(t.entryPortId)
      .where(sql`${t.entryPortId} is not null`),
    index("shipments_in_bond_destination_port_idx")
      .on(t.inBondDestinationPortId)
      .where(sql`${t.inBondDestinationPortId} is not null`),
    index("shipments_destination_port_idx")
      .on(t.destinationPortId)
      .where(sql`${t.destinationPortId} is not null`),
    index("shipments_sublocation_port_idx")
      .on(t.sublocationPortId)
      .where(sql`${t.sublocationPortId} is not null`),
    /** 0031 — target for the composite keys on commodities, movement_events,
     * movement_amendments, in_bond_records, pars_rns_events. */
    uniqueIndex("shipments_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "shipments_broker_org_fkey",
      columns: [t.brokerId, t.organizationId],
      foreignColumns: [partners.id, partners.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "shipments_consignee_org_fkey",
      columns: [t.consigneeId, t.organizationId],
      foreignColumns: [partners.id, partners.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "shipments_import_batch_org_fkey",
      columns: [t.importBatchId, t.organizationId],
      foreignColumns: [importBatches.id, importBatches.organizationId],
    }).onDelete("set null"),
    foreignKey({
      name: "shipments_movement_org_fkey",
      columns: [t.movementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("set null"),
    foreignKey({
      name: "shipments_shipper_org_fkey",
      columns: [t.shipperId, t.organizationId],
      foreignColumns: [partners.id, partners.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "shipments_source_document_org_fkey",
      columns: [t.sourceDocumentId, t.organizationId],
      foreignColumns: [sourceDocuments.id, sourceDocuments.organizationId],
    }).onDelete("set null"),
  ],
);

/** 0019 — `cargo`, renamed and re-parented onto the shipment. */
export const commodities = pgTable(
  "commodities",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** FK is composite — see commodities_shipment_org_fkey below. */
    shipmentId: uuid("shipment_id").notNull(),
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
    /** FK is composite — see commodities_source_document_org_fkey below. */
    sourceDocumentId: uuid("source_document_id"),
    extractionConfidence: numeric("extraction_confidence", {
      precision: 4,
      scale: 3,
      mode: "number",
    }),
    /** 0028 — the CSV batch that created the line.
     * FK is composite — see commodities_import_batch_org_fkey below. */
    importBatchId: uuid("import_batch_id"),
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
    // 0028
    index("commodities_import_batch_idx")
      .on(t.importBatchId)
      .where(sql`${t.importBatchId} is not null`),
    // 0031
    index("commodities_org_import_batch_idx")
      .on(t.organizationId, t.importBatchId)
      .where(sql`${t.importBatchId} is not null`),
    index("commodities_org_shipment_idx").on(t.organizationId, t.shipmentId),
    index("commodities_org_source_document_idx")
      .on(t.organizationId, t.sourceDocumentId)
      .where(sql`${t.sourceDocumentId} is not null`),
    /** 0031 — target for the composite key on commodity_hazmat. */
    uniqueIndex("commodities_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "commodities_import_batch_org_fkey",
      columns: [t.importBatchId, t.organizationId],
      foreignColumns: [importBatches.id, importBatches.organizationId],
    }).onDelete("set null"),
    foreignKey({
      name: "commodities_shipment_org_fkey",
      columns: [t.shipmentId, t.organizationId],
      foreignColumns: [shipments.id, shipments.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "commodities_source_document_org_fkey",
      columns: [t.sourceDocumentId, t.organizationId],
      foreignColumns: [sourceDocuments.id, sourceDocuments.organizationId],
    }).onDelete("set null"),
  ],
);

/** 0028 — one CSV upload of shipments or commodity lines, with its row report. */
export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["shipments", "commodities"] }).notNull(),
    filename: text("filename").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    okCount: integer("ok_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    status: text("status", { enum: ["validated", "committed", "deleted"] })
      .notNull()
      .default("validated"),
    report: jsonb("report").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("import_batches_organization_id_idx").on(t.organizationId),
    index("import_batches_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    /** 0031 — target for the composite keys on commodities and shipments. */
    uniqueIndex("import_batches_id_organization_unique").on(t.id, t.organizationId),
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
    /** FK is composite — see commodity_hazmat_commodity_org_fkey below. */
    commodityId: uuid("commodity_id").notNull(),
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
    // 0031
    index("commodity_hazmat_org_commodity_idx").on(t.organizationId, t.commodityId),
    // 0031 — parent key, ready for a future composite FK onto this table.
    uniqueIndex("commodity_hazmat_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "commodity_hazmat_commodity_org_fkey",
      columns: [t.commodityId, t.organizationId],
      foreignColumns: [commodities.id, commodities.organizationId],
    }).onDelete("cascade"),
  ],
);

export const seals = pgTable(
  "seals",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** FK is composite — see seals_movement_org_fkey below. */
    movementId: uuid("movement_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** 0021 — the trailer slot the seal is on; null = a seal on the truck.
     * FK is composite — see seals_movement_trailer_org_fkey below. */
    movementTrailerId: uuid("movement_trailer_id"),
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
    // 0021
    index("seals_movement_trailer_idx")
      .on(t.movementTrailerId)
      .where(sql`${t.movementTrailerId} is not null`),
    // 0031
    index("seals_org_movement_idx").on(t.organizationId, t.movementId),
    index("seals_org_movement_trailer_idx").on(t.organizationId, t.movementTrailerId),
    // 0031 — parent key, ready for a future composite FK onto this table.
    uniqueIndex("seals_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "seals_movement_org_fkey",
      columns: [t.movementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "seals_movement_trailer_org_fkey",
      columns: [t.movementTrailerId, t.organizationId],
      foreignColumns: [movementTrailers.id, movementTrailers.organizationId],
    }).onDelete("cascade"),
  ],
);

/**
 * 0027 — CBSA Release Notification System messages for PARS shipments, one
 * per message; the PARS RNS screen reads them by PARS number and release code.
 */
export const parsRnsEvents = pgTable(
  "pars_rns_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** FK is composite — see pars_rns_events_shipment_org_fkey below. */
    shipmentId: uuid("shipment_id"),
    parsNumber: text("pars_number").notNull(),
    releaseCode: text("release_code"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    officeCode: text("office_code"),
    sublocationCode: text("sublocation_code"),
    transactionNumber: text("transaction_number"),
    containerNumber: text("container_number"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pars_rns_events_organization_id_idx").on(t.organizationId),
    index("pars_rns_events_org_received_idx").on(t.organizationId, t.receivedAt.desc()),
    index("pars_rns_events_pars_idx").on(t.parsNumber),
    // 0031
    index("pars_rns_events_org_shipment_idx")
      .on(t.organizationId, t.shipmentId)
      .where(sql`${t.shipmentId} is not null`),
    // 0031 — parent key, ready for a future composite FK onto this table.
    uniqueIndex("pars_rns_events_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "pars_rns_events_shipment_org_fkey",
      columns: [t.shipmentId, t.organizationId],
      foreignColumns: [shipments.id, shipments.organizationId],
    }).onDelete("set null"),
  ],
);
