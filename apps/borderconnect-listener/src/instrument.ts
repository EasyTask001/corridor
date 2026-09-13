import * as Sentry from "@sentry/node";
import { scrubTelemetryEvent } from "@corridor/observability";
import { startOtlpMetrics } from "@corridor/observability/runtime";

function traceSampleRate(): number {
  const value = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1");
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.1;
}

startOtlpMetrics("corridor-borderconnect-listener");

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
  release: process.env.SENTRY_RELEASE,
  sendDefaultPii: false,
  tracesSampleRate: traceSampleRate(),
  beforeSend: (event) => scrubTelemetryEvent(event),
});
