import { sql } from "drizzle-orm";
import {
  customType,
  date,
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

export const regulationDocuments = pgTable("regulation_documents", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  source: text("source").notNull(),
  title: text("title").notNull(),
  jurisdiction: text("jurisdiction", { enum: ["US", "CA"] }).notNull(),
  effectiveDate: date("effective_date"),
  url: text("url"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
