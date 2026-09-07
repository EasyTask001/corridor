import { describe, expect, it } from "vitest";
import {
  billingMode,
  meterEventNameFor,
  readStripeEnv,
  reportUsage,
  type UsageMeterRecord,
} from "./stripe";

const record = (over: Partial<UsageMeterRecord> = {}): UsageMeterRecord => ({
  id: 1,
  organizationId: "11111111-1111-1111-1111-111111111111",
  metric: "documents_extracted",
  quantity: 1,
  occurredAt: new Date("2026-09-06T12:00:00Z"),
  stripeCustomerId: "cus_123",
  ...over,
});

/** No STRIPE_SECRET_KEY — the mode every local run and CI job takes. */
const mockEnv = readStripeEnv({} as NodeJS.ProcessEnv);

describe("meter event names", () => {
  it("falls back to the metric name when no override is configured", () => {
    expect(meterEventNameFor("documents_extracted", mockEnv)).toBe("documents_extracted");
  });

  it("reads STRIPE_METER_<METRIC> from the environment", () => {
    const env = readStripeEnv({
      STRIPE_METER_DOCUMENTS_EXTRACTED: "corridor_docs",
      STRIPE_METER_COPILOT_MESSAGES: "corridor_copilot",
    } as NodeJS.ProcessEnv);
    expect(meterEventNameFor("documents_extracted", env)).toBe("corridor_docs");
    expect(meterEventNameFor("copilot_messages", env)).toBe("corridor_copilot");
    // A metric with no override still meters under its own name.
    expect(meterEventNameFor("ai_suggestions", env)).toBe("ai_suggestions");
  });

  it("ignores empty overrides", () => {
    const env = readStripeEnv({ STRIPE_METER_COPILOT_MESSAGES: "" } as NodeJS.ProcessEnv);
    expect(meterEventNameFor("copilot_messages", env)).toBe("copilot_messages");
  });
});

describe("reportUsage in mock mode", () => {
  it("is the mode taken when no secret key is configured", () => {
    expect(billingMode(mockEnv)).toBe("mock");
  });

  it("settles every record with a synthetic id and no network call", async () => {
    const records = [record({ id: 7 }), record({ id: 8, metric: "copilot_messages" })];
    const results = await reportUsage(records, mockEnv);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id)).toEqual([7, 8]);
    for (const result of results) {
      expect(result.mode).toBe("mock");
      expect(result.eventId).toMatch(/^mock_[0-9a-f-]{36}$/);
    }
  });

  it("gives each record its own id", async () => {
    const results = await reportUsage([record({ id: 1 }), record({ id: 2 })], mockEnv);
    expect(results[0]!.eventId).not.toBe(results[1]!.eventId);
  });

  it("does not need a Stripe customer to settle a record", async () => {
    const results = await reportUsage([record({ stripeCustomerId: null })], mockEnv);
    expect(results[0]!.mode).toBe("mock");
    expect(results[0]!.eventId).toMatch(/^mock_/);
  });

  it("returns nothing for an empty batch", async () => {
    expect(await reportUsage([], mockEnv)).toEqual([]);
  });
});
