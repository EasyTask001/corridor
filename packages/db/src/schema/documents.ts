import { sql } from "drizzle-orm";
import {
  bigint,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ExtractedDocument } from "@corridor/domain";
import { authUsers, organizations } from "./core";
import { movements } from "./movements";

export const sourceDocuments = pgTable(
  "source_documents",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** FK is composite — see source_documents_movement_org_fkey below. */
    movementId: uuid("movement_id"),
    documentType: text("document_type", { enum: ["bol", "invoice", "rate_confirmation", "other"] })
      .notNull()
      .default("other"),
    detectedType: text("detected_type", { enum: ["bol", "invoice", "rate_confirmation", "other"] }),
    storagePath: text("storage_path").notNull().unique(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    uploadStatus: text("upload_status", {
      enum: ["uploaded", "processing", "extracted", "failed", "applied"],
    })
      .notNull()
      .default("uploaded"),
    extractedJson: jsonb("extracted_json").$type<ExtractedDocument>(),
    extractionModel: text("extraction_model"),
    extractionConfidence: numeric("extraction_confidence", {
      precision: 4,
      scale: 3,
      mode: "number",
    }),
    extractionError: text("extraction_error"),
    extractionStartedAt: timestamp("extraction_started_at", { withTimezone: true }),
    extractionCompletedAt: timestamp("extraction_completed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by").references(() => authUsers.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** FK is composite — see source_documents_applied_movement_org_fkey below. */
    appliedMovementId: uuid("applied_movement_id"),
    uploadedBy: uuid("uploaded_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("source_documents_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    index("source_documents_org_status_idx").on(t.organizationId, t.uploadStatus),
    index("source_documents_movement_idx")
      .on(t.movementId)
      .where(sql`${t.movementId} is not null`),
    // 0034
    index("source_documents_filename_trgm_idx").using("gin", t.originalFilename),
    // 0031
    index("source_documents_org_applied_movement_idx")
      .on(t.organizationId, t.appliedMovementId)
      .where(sql`${t.appliedMovementId} is not null`),
    index("source_documents_org_movement_idx")
      .on(t.organizationId, t.movementId)
      .where(sql`${t.movementId} is not null`),
    /** 0031 — target for the composite keys on commodities and shipments. */
    uniqueIndex("source_documents_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "source_documents_applied_movement_org_fkey",
      columns: [t.appliedMovementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("set null"),
    foreignKey({
      name: "source_documents_movement_org_fkey",
      columns: [t.movementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("set null"),
  ],
);

export const GENERATED_DOCUMENT_KINDS = [
  "driver_sheet",
  "blank_driver_sheet",
  "manifest_summary",
  "report",
  "registry_export",
] as const;

/** 0024 — every PDF Corridor renders, stored under <org>/generated/… in `documents`. */
export const generatedDocuments = pgTable(
  "generated_documents",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** FK is composite — see generated_documents_movement_org_fkey below. */
    movementId: uuid("movement_id"),
    kind: text("kind", { enum: GENERATED_DOCUMENT_KINDS }).notNull(),
    storagePath: text("storage_path").notNull().unique(),
    contentType: text("content_type").notNull().default("application/pdf"),
    byteSize: bigint("byte_size", { mode: "number" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("generated_documents_organization_id_idx").on(t.organizationId),
    index("generated_documents_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    index("generated_documents_movement_idx")
      .on(t.movementId, t.createdAt.desc())
      .where(sql`${t.movementId} is not null`),
    // 0031
    index("generated_documents_org_movement_idx")
      .on(t.organizationId, t.movementId)
      .where(sql`${t.movementId} is not null`),
    // 0031 — parent key, ready for a future composite FK onto this table.
    uniqueIndex("generated_documents_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "generated_documents_movement_org_fkey",
      columns: [t.movementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("cascade"),
  ],
);
