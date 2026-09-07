import { reportQuery, type ReportQuery } from "@corridor/domain";

export class UnsupportedReportQuestionError extends Error {
  override readonly name = "UnsupportedReportQuestionError";
}

export interface ReportTranslation {
  query: ReportQuery;
  title: string;
  interpretation: string;
}

const STATUS_WORDS = [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "released",
  "held",
  "arrived",
  "cancelled",
] as const;

export function translateReportQuestion(question: string): ReportTranslation {
  const text = question.trim().toLowerCase();
  if (!text || text.length > 500) {
    throw new UnsupportedReportQuestionError("Enter a reporting question under 500 characters.");
  }
  if (/\b(wait time|revenue|profit|cost|driver performance)\b/.test(text)) {
    throw new UnsupportedReportQuestionError(
      "That measure is not available yet. Ask about movements, cargo weight, pieces, declared value, rejection rate, or hold rate.",
    );
  }
  if (
    !/\b(movement|movements|manifest|manifests|shipment|shipments|load|loads|cargo|weight|pieces?|value|rejection|rejected|hold|held)\b/.test(
      text,
    )
  ) {
    throw new UnsupportedReportQuestionError(
      "Ask about movements, cargo weight, pieces, declared value, rejection rate, or hold rate.",
    );
  }
  const requestedDays = text.match(/\b(?:last|past)\s+(\d+)\s+days?\b/)?.[1];
  if (requestedDays && !["7", "30", "90"].includes(requestedDays)) {
    throw new UnsupportedReportQuestionError("Supported rolling ranges are 7, 30, or 90 days.");
  }

  const metric: ReportQuery["metric"] = /\b(rejection rate|reject rate)\b/.test(text)
    ? "rejection_rate"
    : /\b(hold rate|held rate)\b/.test(text)
      ? "hold_rate"
      : /\baverage\b/.test(text) && /\b(weight|kg|kilograms?)\b/.test(text)
        ? "average_cargo_weight_kg"
        : /\b(weight|kg|kilograms?)\b/.test(text)
          ? "cargo_weight_kg"
          : /\b(piece|pieces)\b/.test(text)
            ? "piece_count"
            : /\b(declared value|cargo value|shipment value|value)\b/.test(text)
              ? "declared_value"
              : "movement_count";

  const dimension: ReportQuery["dimension"] = /\b(by|per|grouped by)\s+(status|state)\b/.test(text)
    ? "status"
    : /\b(by|per|grouped by)\s+(regime|direction)\b|\bace\s+(vs|versus)\s+aci\b/.test(text)
      ? "regime"
      : /\b(by|per|grouped by)\s+(crossing|port|border crossing)\b/.test(text)
        ? "crossing"
        : /\b(by month|per month|monthly|month over month)\b/.test(text)
          ? "month"
          : "none";

  const range: ReportQuery["range"] = /\btoday\b/.test(text)
    ? "today"
    : /\blast\s+7\s+days?\b|\bpast week\b/.test(text)
      ? "last_7_days"
      : /\blast\s+30\s+days?\b|\bpast month\b/.test(text)
        ? "last_30_days"
        : /\blast\s+90\s+days?\b|\bpast quarter\b/.test(text)
          ? "last_90_days"
          : /\bthis month\b/.test(text)
            ? "this_month"
            : /\bthis year\b|\byear to date\b|\bytd\b/.test(text)
              ? "this_year"
              : /\ball time\b|\bever\b/.test(text)
                ? "all_time"
                : "last_30_days";

  const regime =
    /\bace\b/.test(text) && !/\baci\b/.test(text)
      ? "ACE"
      : /\baci\b/.test(text) && !/\bace\b/.test(text)
        ? "ACI"
        : undefined;
  const status =
    metric === "rejection_rate" || metric === "hold_rate" || dimension === "status"
      ? undefined
      : STATUS_WORDS.find((candidate) => new RegExp(`\\b${candidate}\\b`).test(text));
  const currency = metric !== "declared_value" ? undefined : /\bcad\b/.test(text) ? "CAD" : "USD";

  const query = reportQuery.parse({ metric, dimension, range, regime, status, currency });
  const metricLabel = {
    movement_count: "Movement count",
    cargo_weight_kg: "Cargo weight",
    average_cargo_weight_kg: "Average cargo weight",
    piece_count: "Piece count",
    declared_value: "Declared value",
    rejection_rate: "Rejection rate",
    hold_rate: "Hold rate",
  }[query.metric];
  const dimensionLabel = query.dimension === "none" ? "" : ` by ${query.dimension}`;
  const filters = [query.regime, query.status, query.currency].filter(Boolean).join(", ");
  const rangeLabel = query.range.replaceAll("_", " ");

  return {
    query,
    title: `${metricLabel}${dimensionLabel}`,
    interpretation: `${metricLabel}${dimensionLabel} for ${rangeLabel}${filters ? `, filtered to ${filters}` : ""}.`,
  };
}
