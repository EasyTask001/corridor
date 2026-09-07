import { describe, expect, it } from "vitest";
import { UnsupportedReportQuestionError, translateReportQuestion } from "./translate";

describe("translateReportQuestion", () => {
  it("translates movement status questions into the constrained DSL", () => {
    expect(
      translateReportQuestion("How many movements by status in the last 30 days?").query,
    ).toEqual({
      metric: "movement_count",
      dimension: "status",
      range: "last_30_days",
    });
  });

  it("keeps rate questions unfiltered so the denominator remains meaningful", () => {
    expect(
      translateReportQuestion("Rejection rate by regime for ACE in the last 90 days").query,
    ).toEqual({
      metric: "rejection_rate",
      dimension: "regime",
      range: "last_90_days",
      regime: "ACE",
    });
  });

  it("recognizes cargo aggregation, currency, and monthly grouping", () => {
    expect(translateReportQuestion("Show declared value in USD by month this year").query).toEqual({
      metric: "declared_value",
      dimension: "month",
      range: "this_year",
      currency: "USD",
    });
  });

  it("does not apply irrelevant currency words to non-value metrics", () => {
    expect(translateReportQuestion("How many USD movements all time?").query).toEqual({
      metric: "movement_count",
      dimension: "none",
      range: "all_time",
    });
  });

  it("rejects unsupported measures instead of silently answering another question", () => {
    expect(() => translateReportQuestion("Average border wait time by driver")).toThrow(
      UnsupportedReportQuestionError,
    );
  });
});
