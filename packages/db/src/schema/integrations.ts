import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
    movementId: uuid("movement_id").references(() => movements.id, { onDelete: "set null" }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("background_jobs_org_idx").on(t.organizationId, t.createdAt.desc()),
    index("background_jobs_due_idx")
      .on(t.runAt)
      .where(sql`${t.status} = 'pending'`),
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
