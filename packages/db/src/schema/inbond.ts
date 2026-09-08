import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authUsers, organizations } from "./core";
import { shipments } from "./movements";
import { ports } from "./reference";

export const IN_BOND_STATUSES = [
  "open",
  "arrival_sent",
  "arrived",
  "export_sent",
  "exported",
  "cancelled",
] as const;

/** 0026 — a shipment another carrier filed, moved by us under bond. */
export const externalShipments = pgTable(
  "external_shipments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    regime: text("regime", { enum: ["ACE", "ACI"] }).notNull(),
    controlNumber: text("control_number"),
    inBondNumber: text("in_bond_number"),
    originatingCarrierCode: text("originating_carrier_code"),
    description: text("description"),
    status: text("status", { enum: ["open", "closed"] })
      .notNull()
      .default("open"),
    createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("external_shipments_organization_id_idx").on(t.organizationId),
    index("external_shipments_org_status_idx").on(t.organizationId, t.status),
  ],
);

/** 0026 — one in-bond move (IT / TE / IE) for one of our shipments or an external one. */
export const inBondRecords = pgTable(
  "in_bond_records",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    shipmentId: uuid("shipment_id").references(() => shipments.id, { onDelete: "cascade" }),
    externalShipmentId: uuid("external_shipment_id").references(() => externalShipments.id, {
      onDelete: "cascade",
    }),
    bondNumber: text("bond_number"),
    entryType: text("entry_type", { enum: ["IT", "TE", "IE"] }).notNull(),
    arrivalPortId: uuid("arrival_port_id").references(() => ports.id),
    exportPortId: uuid("export_port_id").references(() => ports.id),
    firmsCode: text("firms_code"),
    status: text("status", { enum: IN_BOND_STATUSES }).notNull().default("open"),
    lastStatusCheckedAt: timestamp("last_status_checked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("in_bond_records_organization_id_idx").on(t.organizationId),
    index("in_bond_records_org_status_idx").on(t.organizationId, t.status),
    uniqueIndex("in_bond_records_shipment_unique")
      .on(t.shipmentId)
      .where(sql`${t.shipmentId} is not null`),
    uniqueIndex("in_bond_records_external_unique")
      .on(t.externalShipmentId)
      .where(sql`${t.externalShipmentId} is not null`),
    index("in_bond_records_bond_idx")
      .on(t.bondNumber)
      .where(sql`${t.bondNumber} is not null`),
  ],
);

/** 0026 — what was sent to and heard from customs about one in-bond move. */
export const inBondEvents = pgTable(
  "in_bond_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    inBondRecordId: uuid("in_bond_record_id")
      .notNull()
      .references(() => inBondRecords.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "arrival_sent",
        "export_sent",
        "cancel_sent",
        "status_requested",
        "customs_response",
        "note",
      ],
    }).notNull(),
    actorType: text("actor_type", { enum: ["user", "system", "customs_api"] }).notNull(),
    actorId: uuid("actor_id").references(() => authUsers.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("in_bond_events_organization_id_idx").on(t.organizationId),
    index("in_bond_events_record_idx").on(t.inBondRecordId, t.occurredAt.desc()),
  ],
);
