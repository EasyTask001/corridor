import { sql } from "drizzle-orm";
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { USAGE_METRICS } from "@corridor/domain";
import { organizations } from "./core";

/**
 * Mirror of `usage_records` (migration 0013). Rows are written through the
 * SECURITY DEFINER `record_usage()` (see services/usage.ts); `authenticated`
 * has SELECT only, gated on `billing.manage`.
 */
export const usageRecords = pgTable(
  "usage_records",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    metric: text("metric", { enum: USAGE_METRICS }).notNull(),
    quantity: integer("quantity").notNull().default(1),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /** First day of the calendar month (UTC) that `occurredAt` falls in. */
    periodStart: date("period_start").notNull(),
    stripeMeterEventId: text("stripe_meter_event_id"),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    index("usage_records_org_period_metric_idx").on(t.organizationId, t.periodStart, t.metric),
    index("usage_records_unreported_idx")
      .on(t.occurredAt)
      .where(sql`${t.reportedAt} is null`),
  ],
);
