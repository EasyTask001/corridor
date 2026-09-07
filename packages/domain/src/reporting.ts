import { z } from "zod";

export const reportMetric = z.enum([
  "movement_count",
  "cargo_weight_kg",
  "average_cargo_weight_kg",
  "piece_count",
  "declared_value",
  "rejection_rate",
  "hold_rate",
]);
export type ReportMetric = z.infer<typeof reportMetric>;

export const reportDimension = z.enum(["none", "status", "regime", "crossing", "month"]);
export type ReportDimension = z.infer<typeof reportDimension>;

export const reportRange = z.enum([
  "today",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "this_month",
  "this_year",
  "all_time",
]);
export type ReportRange = z.infer<typeof reportRange>;

/** The only query shape the reporting executor accepts. */
export const reportQuery = z.object({
  metric: reportMetric,
  dimension: reportDimension.default("none"),
  range: reportRange.default("last_30_days"),
  regime: z.enum(["ACE", "ACI"]).optional(),
  status: z
    .enum(["draft", "sent", "accepted", "rejected", "released", "held", "arrived", "cancelled"])
    .optional(),
  currency: z.enum(["USD", "CAD"]).optional(),
});
export type ReportQuery = z.infer<typeof reportQuery>;
