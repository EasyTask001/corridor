import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers, organizations } from "./core";
import { drivers, partners, trailers, trucks } from "./registry";

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
    crossingPoint: jsonb("crossing_point").$type<{ code: string; name?: string }>(),
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
    index("movements_org_created_idx").on(t.organizationId, t.createdAt),
    unique("movements_organization_id_movement_number_key").on(t.organizationId, t.movementNumber),
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
  (t) => [index("movement_events_movement_idx").on(t.movementId, t.occurredAt)],
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
  (t) => [index("movement_amendments_movement_idx").on(t.movementId)],
);

export const cargo = pgTable(
  "cargo",
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
    lineNumber: integer("line_number").notNull().default(1),
    shipperId: uuid("shipper_id").references(() => partners.id, { onDelete: "restrict" }),
    consigneeId: uuid("consignee_id").references(() => partners.id, { onDelete: "restrict" }),
    commodityDescription: text("commodity_description").notNull(),
    hsCode: text("hs_code"),
    weightKg: numeric("weight_kg", { precision: 12, scale: 2, mode: "number" }),
    pieceCount: integer("piece_count"),
    packagingType: text("packaging_type"),
    entryNumber: text("entry_number"),
    inBondNumber: text("in_bond_number"),
    valueAmount: numeric("value_amount", { precision: 14, scale: 2, mode: "number" }),
    valueCurrency: text("value_currency", { enum: ["USD", "CAD"] }),
    countryOfOrigin: text("country_of_origin"),
    sourceDocumentId: uuid("source_document_id"),
    extractionConfidence: numeric("extraction_confidence", {
      precision: 4,
      scale: 3,
      mode: "number",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cargo_movement_idx").on(t.movementId, t.lineNumber)],
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
  (t) => [index("seals_movement_idx").on(t.movementId)],
);
