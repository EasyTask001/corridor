import { sql } from "drizzle-orm";
import {
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers, organizations } from "./core";
import { movements } from "./movements";
import { drivers, trailers, trucks } from "./registry";

export const complianceAlerts = pgTable(
  "compliance_alerts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** FKs are composite — see compliance_alerts_*_org_fkey below. */
    movementId: uuid("movement_id"),
    driverId: uuid("driver_id"),
    truckId: uuid("truck_id"),
    trailerId: uuid("trailer_id"),
    alertType: text("alert_type", {
      enum: ["document_expiry", "hold_prediction", "risk_flag", "missing_data", "hs_code_mismatch"],
    }).notNull(),
    severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", { enum: ["open", "acknowledged", "resolved", "dismissed"] })
      .notNull()
      .default("open"),
    dedupeKey: text("dedupe_key"),
    source: text("source", { enum: ["rules", "ai", "user"] })
      .notNull()
      .default("rules"),
    dueAt: date("due_at"),
    acknowledgedBy: uuid("acknowledged_by").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => authUsers.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("compliance_alerts_organization_id_idx").on(t.organizationId),
    index("compliance_alerts_org_type_status_idx").on(t.organizationId, t.alertType, t.status),
    index("compliance_alerts_org_status_severity_idx").on(t.organizationId, t.status, t.severity),
    index("compliance_alerts_driver_idx")
      .on(t.driverId)
      .where(sql`${t.driverId} is not null`),
    index("compliance_alerts_truck_idx")
      .on(t.truckId)
      .where(sql`${t.truckId} is not null`),
    index("compliance_alerts_trailer_idx")
      .on(t.trailerId)
      .where(sql`${t.trailerId} is not null`),
    index("compliance_alerts_movement_idx")
      .on(t.movementId)
      .where(sql`${t.movementId} is not null`),
    uniqueIndex("compliance_alerts_open_dedupe_unique")
      .on(t.organizationId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.status} in ('open','acknowledged')`),
    // 0011
    index("compliance_alerts_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    // 0031
    index("compliance_alerts_org_driver_idx").on(t.organizationId, t.driverId),
    index("compliance_alerts_org_movement_idx").on(t.organizationId, t.movementId),
    index("compliance_alerts_org_trailer_idx").on(t.organizationId, t.trailerId),
    index("compliance_alerts_org_truck_idx").on(t.organizationId, t.truckId),
    foreignKey({
      name: "compliance_alerts_driver_org_fkey",
      columns: [t.driverId, t.organizationId],
      foreignColumns: [drivers.id, drivers.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "compliance_alerts_movement_org_fkey",
      columns: [t.movementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "compliance_alerts_trailer_org_fkey",
      columns: [t.trailerId, t.organizationId],
      foreignColumns: [trailers.id, trailers.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "compliance_alerts_truck_org_fkey",
      columns: [t.truckId, t.organizationId],
      foreignColumns: [trucks.id, trucks.organizationId],
    }).onDelete("cascade"),
  ],
);
