import * as Sentry from "@sentry/nextjs";
import { startOtlpMetrics } from "@corridor/observability/runtime";

export async function register() {
  startOtlpMetrics("corridor-web");
  if (process.env.NEXT_RUNTIME === "nodejs") await import("../sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("../sentry.edge.config");
}

export const onRequestError = Sentry.captureRequestError;
