import { sql } from "drizzle-orm";
import {
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./core";

/** pgvector column — Drizzle has no native vector type, so declare it as a custom type. */
const vector = (dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string): number[] {
      return value.slice(1, -1).split(",").filter(Boolean).map(Number);
    },
  });

export const EMBEDDING_DIMENSIONS = 1536;

export const regulationDocuments = pgTable(
  "regulation_documents",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    source: text("source").notNull(),
    title: text("title").notNull(),
    jurisdiction: text("jurisdiction", { enum: ["US", "CA"] }).notNull(),
    effectiveDate: date("effective_date"),
    url: text("url"),
    content: text("content").notNull(),
    /** 0052 — 'CBP' | 'CBSA' | 'USTR' | ... */
    authority: text("authority"),
    /** 0052 — edition/notice identifier, e.g. 'CN 24-27', 'eCFR 2026-09-13'. */
    version: text("version"),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    /** 0052 — match_regulations only ever retrieves 'verified' rows. */
    verificationStatus: text("verification_status", {
      enum: ["draft", "verified", "superseded"],
    })
      .notNull()
      .default("draft"),
    supersededBy: uuid("superseded_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("regulation_documents_source_title_unique").on(t.source, t.title),
    foreignKey({
      name: "regulation_documents_superseded_by_fkey",
      columns: [t.supersededBy],
      foreignColumns: [t.id],
    }).onDelete("set null"),
  ],
);

export const regulationEmbeddings = pgTable(
  "regulation_embeddings",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    regulationDocumentId: uuid("regulation_document_id")
      .notNull()
      .references(() => regulationDocuments.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector(EMBEDDING_DIMENSIONS)("embedding").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** 0052 — which model produced this vector; vectors from different
     * models are not comparable, so match_regulations can filter on it. */
    embedder: text("embedder"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("regulation_embeddings_regulation_document_id_chunk_index_key").on(
      t.regulationDocumentId,
      t.chunkIndex,
    ),
    index("regulation_embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const organizationKnowledgeEmbeddings = pgTable(
  "organization_knowledge_embeddings",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceType: text("source_type", {
      enum: ["movement_note", "hold_resolution", "sop_document"],
    }).notNull(),
    sourceId: uuid("source_id"),
    content: text("content").notNull(),
    embedding: vector(EMBEDDING_DIMENSIONS)("embedding").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("org_knowledge_embeddings_org_idx").on(t.organizationId),
    index("org_knowledge_embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);
