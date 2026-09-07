import { sql } from "drizzle-orm";
import { bigint, index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    movementId: uuid("movement_id").references(() => movements.id, { onDelete: "set null" }),
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
    appliedMovementId: uuid("applied_movement_id").references(() => movements.id, {
      onDelete: "set null",
    }),
    uploadedBy: uuid("uploaded_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("source_documents_org_created_idx").on(t.organizationId, t.createdAt),
    index("source_documents_org_status_idx").on(t.organizationId, t.uploadStatus),
  ],
);
