import { describe, expect, it } from "vitest";
import { buildWatchdogConditions, type CustomsWatchdogSnapshot } from "./customs-watchdog";

function empty(overrides: Partial<CustomsWatchdogSnapshot> = {}): CustomsWatchdogSnapshot {
  return {
    staleSubmissions: 0,
    overdueDrainJobs: 0,
    failedDrainJobs: 0,
    unprocessedInbox: 0,
    repeatedlyFailingInbox: 0,
    unknownRoutes: 0,
    ambiguousRoutes: 0,
    providerRequests: 0,
    providerFailures: 0,
    acknowledgementP95Ms: 0,
    queueDepth: 0,
    oldestJobAgeMs: 0,
    ...overrides,
  };
}

describe("buildWatchdogConditions", () => {
  it("groups every actionable customs business-state condition without row identifiers", () => {
    const conditions = buildWatchdogConditions(
      empty({
        staleSubmissions: 3,
        overdueDrainJobs: 1,
        failedDrainJobs: 2,
        unprocessedInbox: 4,
        repeatedlyFailingInbox: 2,
        unknownRoutes: 2,
        ambiguousRoutes: 1,
        providerRequests: 10,
        providerFailures: 4,
        acknowledgementP95Ms: 180_000,
      }),
    );

    expect(conditions.map((c) => c.code)).toEqual([
      "stale_submission",
      "drain_job_unhealthy",
      "inbox_processing_unhealthy",
      "tenant_routing_unhealthy",
      "provider_failure_elevated",
      "acknowledgement_latency_elevated",
    ]);
    expect(conditions.find((c) => c.code === "drain_job_unhealthy")?.count).toBe(3);
    expect(conditions.find((c) => c.code === "provider_failure_elevated")?.details).toEqual({
      requests: 10,
      failures: 4,
      failureRate: 0.4,
    });
    expect(JSON.stringify(conditions)).not.toMatch(
      /organization|movement|company|shipment|payload/i,
    );
  });

  it("does not alert on a low-volume isolated provider error or healthy acknowledgement latency", () => {
    expect(
      buildWatchdogConditions(
        empty({ providerRequests: 2, providerFailures: 1, acknowledgementP95Ms: 119_999 }),
      ),
    ).toEqual([]);
  });
});
