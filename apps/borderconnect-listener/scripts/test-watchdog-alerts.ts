#!/usr/bin/env tsx
import "../src/instrument";
import * as Sentry from "@sentry/node";
import { buildWatchdogConditions } from "@corridor/api";

if (!process.argv.includes("--confirm")) {
  throw new Error(
    "Refusing to emit Sentry test issues without --confirm. This command intentionally pages configured test recipients.",
  );
}
if (!process.env.SENTRY_DSN) throw new Error("SENTRY_DSN is required");

const conditions = buildWatchdogConditions({
  staleSubmissions: 1,
  overdueDrainJobs: 1,
  failedDrainJobs: 1,
  unprocessedInbox: 1,
  repeatedlyFailingInbox: 1,
  unknownRoutes: 1,
  ambiguousRoutes: 1,
  providerRequests: 10,
  providerFailures: 5,
  acknowledgementP95Ms: 180_000,
  queueDepth: 2,
  oldestJobAgeMs: 180_000,
});

for (const condition of conditions) {
  Sentry.captureMessage(`[TEST] ${condition.title}`, {
    level: condition.severity === "critical" ? "fatal" : condition.severity,
    fingerprint: ["customs-watchdog", condition.code],
    tags: {
      component: "customs-watchdog",
      condition: condition.code,
      severity: condition.severity,
      alert_test: "true",
    },
    extra: condition.details,
  });
}

const flushed = await Sentry.flush(5_000);
if (!flushed) throw new Error("Sentry did not flush watchdog test events within five seconds");
console.log(`Emitted ${conditions.length} redacted watchdog test events.`);
