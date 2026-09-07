import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gte, schema, sql, type RlsTransaction, type SQL } from "@corridor/db";
import { reportQuery, type ReportQuery } from "@corridor/domain";
import { translateReportQuestion, UnsupportedReportQuestionError } from "@corridor/ai";
import { permissionProcedure, router } from "../trpc";

const { movements, cargo } = schema;

const reportInput = z.object({ question: z.string().trim().min(1).max(500) });

function rangeStart(range: ReportQuery["range"], now = new Date()): Date | null {
  if (range === "all_time") return null;
  if (range === "today")
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (range === "this_month") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (range === "this_year") return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const days = { last_7_days: 7, last_30_days: 30, last_90_days: 90 }[range];
  return new Date(now.getTime() - days * 86_400_000);
}

function dimensionSql(dimension: ReportQuery["dimension"]): { label: SQL<string>; group: SQL } {
  switch (dimension) {
    case "status":
      return { label: sql<string>`${movements.status}`, group: sql`${movements.status}` };
    case "regime":
      return { label: sql<string>`${movements.regime}`, group: sql`${movements.regime}` };
    case "crossing": {
      const expression = sql<string>`coalesce(${movements.crossingPoint} ->> 'name', ${movements.crossingPoint} ->> 'code', 'Unspecified')`;
      return { label: expression, group: expression };
    }
    case "month": {
      const expression = sql<string>`to_char(date_trunc('month', ${movements.createdAt}), 'YYYY-MM')`;
      return { label: expression, group: expression };
    }
    default:
      return { label: sql<string>`'Total'`, group: sql`${movements.organizationId}` };
  }
}

function metricSql(metric: ReportQuery["metric"]): SQL<number> {
  switch (metric) {
    case "cargo_weight_kg":
      return sql<number>`coalesce(sum(${cargo.weightKg}), 0)::float8`;
    case "average_cargo_weight_kg":
      return sql<number>`coalesce(sum(${cargo.weightKg}) / nullif(count(distinct ${movements.id}), 0), 0)::float8`;
    case "piece_count":
      return sql<number>`coalesce(sum(${cargo.pieceCount}), 0)::float8`;
    case "declared_value":
      return sql<number>`coalesce(sum(${cargo.valueAmount}), 0)::float8`;
    case "rejection_rate":
      return sql<number>`coalesce(
        100.0 * count(distinct ${movements.id}) filter (
          where exists (
            select 1 from public.movement_events e
            where e.movement_id = ${movements.id} and e.to_status = 'rejected'
          )
        ) / nullif(count(distinct ${movements.id}), 0), 0
      )::float8`;
    case "hold_rate":
      return sql<number>`coalesce(
        100.0 * count(distinct ${movements.id}) filter (
          where exists (
            select 1 from public.movement_events e
            where e.movement_id = ${movements.id} and e.to_status = 'held'
          )
        ) / nullif(count(distinct ${movements.id}), 0), 0
      )::float8`;
    default:
      return sql<number>`count(distinct ${movements.id})::float8`;
  }
}

async function executeReport(tx: RlsTransaction, orgId: string, query: ReportQuery) {
  const dimension = dimensionSql(query.dimension);
  const value = metricSql(query.metric);
  const start = rangeStart(query.range);
  const filters = [
    eq(movements.organizationId, orgId),
    start ? gte(movements.createdAt, start) : undefined,
    query.regime ? eq(movements.regime, query.regime) : undefined,
    query.status ? eq(movements.status, query.status) : undefined,
    query.metric === "declared_value" && query.currency
      ? eq(cargo.valueCurrency, query.currency)
      : undefined,
  ];

  return tx
    .select({ label: dimension.label, value })
    .from(movements)
    .leftJoin(cargo, eq(cargo.movementId, movements.id))
    .where(and(...filters))
    .groupBy(dimension.group)
    .orderBy(query.dimension === "month" ? dimension.label : desc(value))
    .limit(60);
}

function unitFor(query: ReportQuery) {
  if (query.metric === "cargo_weight_kg" || query.metric === "average_cargo_weight_kg") return "kg";
  if (query.metric === "piece_count") return "pieces";
  if (query.metric === "declared_value") return query.currency ?? "USD";
  if (query.metric === "rejection_rate" || query.metric === "hold_rate") return "%";
  return "movements";
}

function summarize(
  title: string,
  rows: Array<{ label: string; value: number }>,
  unit: string,
  metric: ReportQuery["metric"],
) {
  if (rows.length === 0) return `No matching data was found for ${title.toLowerCase()}.`;
  const format = (value: number) =>
    `${value.toLocaleString("en-CA", { maximumFractionDigits: unit === "%" ? 1 : 2 })}${unit === "%" ? "%" : ` ${unit}`}`;
  if (rows.length === 1) return `${title}: ${format(rows[0]!.value)}.`;
  const top = [...rows].sort((a, b) => b.value - a.value)[0]!;
  if (unit === "%" || metric === "average_cargo_weight_kg") {
    return `${top.label} has the highest result at ${format(top.value)}.`;
  }
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return `${format(total)} across ${rows.length} groups; ${top.label} is highest at ${format(top.value)}.`;
}

export const reportingRouter = router({
  run: permissionProcedure("report.read", "movement.read")
    .input(reportInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        let translated;
        try {
          translated = translateReportQuestion(input.question);
        } catch (error) {
          if (error instanceof UnsupportedReportQuestionError) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
          }
          throw error;
        }
        const query = reportQuery.parse(translated.query);
        const rows = await executeReport(tx, ctx.orgId, query);
        const unit = unitFor(query);
        return {
          ...translated,
          query,
          unit,
          rows,
          summary: summarize(translated.title, rows, unit, query.metric),
        };
      }),
    ),
});
