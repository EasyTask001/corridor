import * as Sentry from "@sentry/nextjs";
import { scrubTelemetryEvent } from "@corridor/observability";

const configuredRate = Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.05");

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  sendDefaultPii: false,
  tracesSampleRate:
    Number.isFinite(configuredRate) && configuredRate >= 0 && configuredRate <= 1
      ? configuredRate
      : 0.05,
  beforeSend: (event) => scrubTelemetryEvent(event),
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
