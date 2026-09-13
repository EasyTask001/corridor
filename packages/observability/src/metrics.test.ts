import type { Meter } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { createCorridorMetrics, METRIC_NAMES } from "./metrics";

function fakeMeter() {
  const records: Array<{ name: string; value: number; attributes?: Record<string, unknown> }> = [];
  const instrument = (name: string) => ({
    add: (value: number, attributes?: Record<string, unknown>) =>
      records.push({ name, value, attributes }),
    record: (value: number, attributes?: Record<string, unknown>) =>
      records.push({ name, value, attributes }),
  });
  const meter = {
    createCounter: vi.fn((name: string) => instrument(name)),
    createHistogram: vi.fn((name: string) => instrument(name)),
    createGauge: vi.fn((name: string) => instrument(name)),
  } as unknown as Meter;
  return { meter, records };
}

describe("Corridor metrics", () => {
  it("defines and records the production customs, queue, extraction, and AI instruments", () => {
    const { meter, records } = fakeMeter();
    const m = createCorridorMetrics(meter);

    m.customsOutbound({
      provider: "border_connect",
      operation: "transmit",
      durationMs: 42,
      ok: false,
    });
    m.customsInbox({
      received: 5,
      stored: 3,
      processed: 2,
      duplicates: 2,
      unroutable: 1,
      failed: 1,
    });
    m.jobQueue({ depth: 7, oldestAgeMs: 12_000 });
    m.submissionAcknowledged({ provider: "border_connect", regime: "ace", latencyMs: 120 });
    m.extraction({ documentType: "bill_of_lading", durationMs: 230, ok: false });
    m.aiFailure({ operation: "copilot", provider: "openai" });
    m.watchdogIssue({ condition: "stale_submission", severity: "critical", count: 2 });

    expect(new Set(records.map((r) => r.name))).toEqual(new Set(Object.values(METRIC_NAMES)));
    expect(records).toContainEqual({
      name: METRIC_NAMES.customsOutboundFailures,
      value: 1,
      attributes: { provider: "border_connect", operation: "transmit" },
    });
    expect(JSON.stringify(records)).not.toMatch(/organization|movement|companyKey|shipmentId/);
  });
});
