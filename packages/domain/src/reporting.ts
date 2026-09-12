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

// ---------------------------------------------------------------------------
// Crossing report, exports and the dashboard (Task 12)
// ---------------------------------------------------------------------------

/** Every column the crossing report can show, in its default order. */
export const CROSSING_REPORT_COLUMNS = [
  { key: "movementNumber", label: "Movement" },
  { key: "tripNumber", label: "Trip" },
  { key: "regime", label: "Regime" },
  { key: "carrierCode", label: "Carrier code" },
  { key: "status", label: "Status" },
  { key: "portCode", label: "Port code" },
  { key: "portName", label: "Port" },
  { key: "scheduledCrossingAt", label: "Scheduled crossing" },
  { key: "submittedAt", label: "Submitted" },
  { key: "acceptedAt", label: "Accepted" },
  { key: "releasedAt", label: "Released" },
  { key: "arrivedAt", label: "Arrived" },
  { key: "picDriver", label: "Driver (PIC)" },
  { key: "crew", label: "Crew" },
  { key: "truckUnit", label: "Truck" },
  { key: "truckPlate", label: "Truck plate" },
  { key: "trailerUnits", label: "Trailers" },
  { key: "sealNumbers", label: "Seals" },
  { key: "shipmentCount", label: "Shipments" },
  { key: "controlNumbers", label: "Control numbers" },
  { key: "entryNumbers", label: "Entry numbers" },
  { key: "shippers", label: "Shippers" },
  { key: "consignees", label: "Consignees" },
  { key: "commodityCount", label: "Commodity lines" },
  { key: "totalWeightKg", label: "Weight (kg)" },
  { key: "declaredValue", label: "Declared value" },
] as const;
export type CrossingColumn = (typeof CROSSING_REPORT_COLUMNS)[number]["key"];
export const CROSSING_COLUMN_KEYS = CROSSING_REPORT_COLUMNS.map((c) => c.key) as [
  CrossingColumn,
  ...CrossingColumn[],
];
export const crossingColumn = z.enum(CROSSING_COLUMN_KEYS);
export const DEFAULT_CROSSING_COLUMNS: CrossingColumn[] = [
  "movementNumber",
  "regime",
  "status",
  "portCode",
  "scheduledCrossingAt",
  "picDriver",
  "truckUnit",
  "trailerUnits",
  "shipmentCount",
  "controlNumbers",
];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** One row per movement whose crossing (scheduled, else created) falls in the range. */
export const crossingReportInput = z
  .object({
    from: isoDate,
    to: isoDate,
    regime: z.enum(["ACE", "ACI"]).optional(),
    driverId: z.string().uuid().optional(),
    portId: z.string().uuid().optional(),
    truckId: z.string().uuid().optional(),
    trailerId: z.string().uuid().optional(),
    columns: z.array(crossingColumn).min(1).default(DEFAULT_CROSSING_COLUMNS),
    limit: z.number().int().min(1).max(1000).default(200),
    offset: z.number().int().min(0).default(0),
  })
  .refine((v) => v.from <= v.to, { message: "The range ends before it starts", path: ["to"] });
export type CrossingReportInput = z.infer<typeof crossingReportInput>;

export const exportFormat = z.enum(["csv", "pdf"]);
export type ExportFormat = z.infer<typeof exportFormat>;

/** Export either the crossing report or a natural-language report's result. */
export const reportExportInput = z.object({
  format: exportFormat,
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("crossings"), query: crossingReportInput }),
    z.object({
      kind: z.literal("query"),
      query: reportQuery,
      title: z.string().trim().min(1).max(120),
    }),
  ]),
});
export type ReportExportInput = z.infer<typeof reportExportInput>;

export const registryExportInput = z.object({
  format: exportFormat,
  includeArchived: z.boolean().default(false),
});
export type RegistryExportInput = z.infer<typeof registryExportInput>;
