import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./core";
import { movements } from "./movements";

export const INTEGRATION_PROVIDERS = [
  "cbp_ace",
  "cbsa_aci",
  "border_wait_time",
  "hts_tariff",
  "stripe",
] as const;

export const integrationConfigs = pgTable(
  "integration_configs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: INTEGRATION_PROVIDERS }).notNull(),
    environment: text("environment", { enum: ["sandbox", "production"] })
      .notNull()
      .default("sandbox"),
    credentialsRef: uuid("credentials_ref"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: ["active", "disabled", "error"] })
      .notNull()
      .default("active"),
    lastError: text("last_error"),
    // 0023 — `mock` keeps the deterministic gateway; `gateway` files through
    // the certified EDI gateway's REST API (fixture replay when unconfigured).
    // 0047 — `border_connect` files through the BorderConnect eManifest API.
    mode: text("mode", { enum: ["mock", "gateway", "border_connect"] })
      .notNull()
      .default("mock"),
    baseUrl: text("base_url"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("integration_configs_org_idx").on(t.organizationId),
    unique("integration_configs_organization_id_provider_key").on(t.organizationId, t.provider),
  ],
);

export const integrationEvents = pgTable(
  "integration_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** FK is composite — see integration_events_movement_org_fkey below. */
    movementId: uuid("movement_id"),
    provider: text("provider").notNull(),
    direction: text("direction", { enum: ["outbound", "inbound"] }).notNull(),
    operation: text("operation").notNull(),
    requestPayload: jsonb("request_payload").$type<Record<string, unknown>>(),
    responsePayload: jsonb("response_payload").$type<Record<string, unknown>>(),
    statusCode: integer("status_code"),
    success: boolean("success").notNull(),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("integration_events_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    index("integration_events_movement_idx")
      .on(t.movementId)
      .where(sql`${t.movementId} is not null`),
    index("integration_events_correlation_idx")
      .on(t.correlationId)
      .where(sql`${t.correlationId} is not null`),
    // 0031
    index("integration_events_org_movement_idx")
      .on(t.organizationId, t.movementId)
      .where(sql`${t.movementId} is not null`),
    // 0031 — parent key, ready for a future composite FK onto this table.
    uniqueIndex("integration_events_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "integration_events_movement_org_fkey",
      columns: [t.movementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("set null"),
  ],
);

export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    jobType: text("job_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: ["pending", "running", "succeeded", "failed", "cancelled"] })
      .notNull()
      .default("pending"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    idempotencyKey: text("idempotency_key"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("background_jobs_org_idx").on(t.organizationId, t.createdAt.desc()),
    index("background_jobs_due_idx")
      .on(t.runAt)
      .where(sql`${t.status} = 'pending'`),
    index("background_jobs_lease_expiry_idx")
      .on(t.leaseExpiresAt)
      .where(sql`${t.status} = 'running' and ${t.leaseExpiresAt} is not null`),
    // 0033 — was never mirrored; caught by verify:mirror's unmirrored-index check.
    uniqueIndex("background_jobs_org_idempotency_unique")
      .on(t.organizationId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    // Queue-wide jobs have organization_id = NULL. PostgreSQL permits
    // multiple NULLs in the tenant-scoped unique index above, so give those
    // jobs their own conflict target as well (0050).
    uniqueIndex("background_jobs_queue_idempotency_unique")
      .on(t.jobType, t.idempotencyKey)
      .where(sql`${t.organizationId} is null and ${t.idempotencyKey} is not null`),
  ],
);

export const CUSTOMS_SUBMISSION_KINDS = ["original", "amendment", "cancel", "in_bond"] as const;
export const CUSTOMS_SUBMISSION_STATUSES = [
  "sent",
  "acknowledged",
  "failed",
  "accepted",
  "rejected",
  "released",
  "held",
  "cancelled",
] as const;

/**
 * 0023 — one manifest filing as the gateway knows it: the reference number it
 * assigned and the status the acknowledgements and decisions move it through.
 * The webhook resolves an inbound message to a movement through this table.
 */
export const customsSubmissions = pgTable(
  "customs_submissions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** FK is composite — see customs_submissions_movement_org_fkey below. */
    movementId: uuid("movement_id"),
    kind: text("kind", { enum: CUSTOMS_SUBMISSION_KINDS }).notNull(),
    provider: text("provider", { enum: ["cbp_ace", "cbsa_aci"] }).notNull(),
    // 0047 — `border_connect` files through the BorderConnect eManifest API.
    mode: text("mode", { enum: ["mock", "gateway", "border_connect"] }).notNull(),
    referenceNumber: text("reference_number"),
    correlationId: text("correlation_id"),
    status: text("status", { enum: CUSTOMS_SUBMISSION_STATUSES }).notNull().default("sent"),
    request: jsonb("request").$type<Record<string, unknown>>(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("customs_submissions_organization_id_idx").on(t.organizationId),
    index("customs_submissions_movement_idx")
      .on(t.movementId, t.createdAt.desc())
      .where(sql`${t.movementId} is not null`),
    index("customs_submissions_reference_idx")
      .on(t.referenceNumber)
      .where(sql`${t.referenceNumber} is not null`),
    // 0031
    index("customs_submissions_org_movement_idx")
      .on(t.organizationId, t.movementId)
      .where(sql`${t.movementId} is not null`),
    // 0031 — parent key, ready for a future composite FK onto this table.
    uniqueIndex("customs_submissions_id_organization_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "customs_submissions_movement_org_fkey",
      columns: [t.movementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("cascade"),
  ],
);

/** 0023 — CBP/CBSA service notices, global like `ports`. */
export const carrierNotices = pgTable(
  "carrier_notices",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    provider: text("provider", { enum: ["cbp_ace", "cbsa_aci"] }).notNull(),
    externalId: text("external_id").notNull().unique(),
    severity: text("severity", { enum: ["info", "warning", "critical"] })
      .notNull()
      .default("info"),
    title: text("title").notNull(),
    body: text("body"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("carrier_notices_published_idx").on(t.publishedAt.desc())],
);

export const CUSTOMS_INBOX_PROVIDERS = ["border_connect"] as const;

/**
 * 0047 — one inbound message from a provider's shared queue, received before
 * its tenant is known (or, for SYSTEM_ALERT / RNS_SHIPMENT, belonging to no
 * tenant at all). See migration 0047's header for why this is not a column on
 * integration_events, customs_submissions or background_jobs.
 */
export const customsInbox = pgTable(
  "customs_inbox",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    provider: text("provider", { enum: CUSTOMS_INBOX_PROVIDERS })
      .notNull()
      .default("border_connect"),
    companyKey: text("company_key"),
    dataType: text("data_type").notNull(),
    sendId: text("send_id"),
    tripNumber: text("trip_number"),
    cargoControlNumber: text("cargo_control_number"),
    shipmentControlNumber: text("shipment_control_number"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadSha256: text("payload_sha256").notNull().unique(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processingError: text("processing_error"),
    /** FK is composite — see customs_inbox_movement_org_fkey below. */
    movementId: uuid("movement_id"),
    /** FK is composite — see customs_inbox_submission_org_fkey below. */
    customsSubmissionId: uuid("customs_submission_id"),
  },
  (t) => [
    index("customs_inbox_unprocessed_idx")
      .on(t.id)
      .where(sql`${t.processedAt} is null`),
    index("customs_inbox_org_received_idx")
      .on(t.organizationId, t.receivedAt.desc())
      .where(sql`${t.organizationId} is not null`),
    // Settings inbox search
    index("customs_inbox_trip_number_idx")
      .on(t.tripNumber)
      .where(sql`${t.tripNumber} is not null`),
    // Settings inbox search
    index("customs_inbox_cargo_control_number_idx")
      .on(t.cargoControlNumber)
      .where(sql`${t.cargoControlNumber} is not null`),
    foreignKey({
      name: "customs_inbox_movement_org_fkey",
      columns: [t.movementId, t.organizationId],
      foreignColumns: [movements.id, movements.organizationId],
    }).onDelete("set null"),
    foreignKey({
      name: "customs_inbox_submission_org_fkey",
      columns: [t.customsSubmissionId, t.organizationId],
      foreignColumns: [customsSubmissions.id, customsSubmissions.organizationId],
    }).onDelete("set null"),
  ],
);

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" })
    .unique(),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  plan: text("plan", { enum: ["trial", "starter", "professional", "enterprise"] }).notNull(),
  status: text("status", {
    enum: ["trialing", "active", "past_due", "canceled", "incomplete"],
  }).notNull(),
  seats: integer("seats").notNull().default(1),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
