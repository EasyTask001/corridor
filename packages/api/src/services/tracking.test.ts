import { describe, expect, it } from "vitest";
import { trackingLookupInput } from "@corridor/domain";
import { resetKvForTests } from "../infra/redis";
import { trackingKeyFor, trackingRateLimit } from "./tracking";

describe("tracking lookup input", () => {
  it("normalises and validates the carrier code and control number", () => {
    expect(
      trackingLookupInput.parse({ carrierCode: " pftr ", controlNumber: "paps 90001" }),
    ).toEqual({
      carrierCode: "PFTR",
      controlNumber: "PAPS90001",
    });
    expect(
      trackingLookupInput.safeParse({ carrierCode: "P", controlNumber: "PAPS90001" }).success,
    ).toBe(false);
    expect(
      trackingLookupInput.safeParse({ carrierCode: "PFTR", controlNumber: "AB" }).success,
    ).toBe(false);
    expect(
      trackingLookupInput.safeParse({ carrierCode: "PFTR", controlNumber: "drop;table" }).success,
    ).toBe(false);
  });
});

describe("tracking rate limit", () => {
  it("hashes the address and allows ten per minute, then refuses", async () => {
    resetKvForTests();
    const headers = {
      get: (n: string) => (n === "x-forwarded-for" ? "203.0.113.9, 10.0.0.1" : null),
    };
    const key = trackingKeyFor(headers);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain("203");
    for (let i = 0; i < 10; i++) expect((await trackingRateLimit(key)).success).toBe(true);
    const eleventh = await trackingRateLimit(key);
    expect(eleventh.success).toBe(false);
    expect(eleventh.retryAfterSeconds).toBeGreaterThan(0);
    // Another address is counted separately.
    expect((await trackingRateLimit(trackingKeyFor({ get: () => "198.51.100.4" }))).success).toBe(
      true,
    );
  });
});
