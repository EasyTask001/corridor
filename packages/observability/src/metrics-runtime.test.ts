import { describe, expect, it } from "vitest";
import { createOtlpMetricsProvider } from "./metrics-runtime";

describe("OTLP metrics runtime", () => {
  it("stays disabled without an explicit metrics endpoint", () => {
    expect(createOtlpMetricsProvider("corridor-test", {})).toBeNull();
  });

  it("creates an exportable provider from standard OTLP environment variables", async () => {
    const provider = createOtlpMetricsProvider("corridor-test", {
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://otel.example/v1/metrics",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=private-value,x-scope=test",
      OTEL_METRIC_EXPORT_INTERVAL: "15000",
      SENTRY_ENVIRONMENT: "test",
    });

    expect(provider).not.toBeNull();
    await provider?.shutdown();
  });
});
