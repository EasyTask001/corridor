import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseInbound } from "./inbound";
import { sanitizeInboundForFixture } from "./sanitize";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, "fixtures", "inbound");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}

const EXISTING_FIXTURES = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));

describe("sanitizeInboundForFixture", () => {
  it("keeps parseInbound's kind identical for every existing hand-written fixture", () => {
    expect(EXISTING_FIXTURES.length).toBeGreaterThan(0);
    for (const file of EXISTING_FIXTURES) {
      const original = loadFixture(file);
      const sanitized = sanitizeInboundForFixture(original);
      expect(parseInbound(sanitized).kind).toBe(parseInbound(original).kind);
    }
  });

  it("is idempotent: sanitizing twice equals sanitizing once", () => {
    for (const file of EXISTING_FIXTURES) {
      const once = sanitizeInboundForFixture(loadFixture(file));
      const twice = sanitizeInboundForFixture(once);
      expect(twice).toEqual(once);
    }
  });

  it("maps identifier fields to the canonical constants inbound.test.ts asserts against", () => {
    const sanitized = sanitizeInboundForFixture({
      data: "ACE_RESPONSE",
      companyKey: "REAL-CARRIER-KEY-1234",
      tripNumber: "REAL260913001",
      sendId: "REAL-SEND-9",
      shipmentStatusList: [{ shipmentControlNumber: "REALCCN0001", code: "11", port: "0901" }],
    }) as Record<string, unknown>;
    expect(sanitized.companyKey).toBe("c-9000-2bcd8ae5954e0c48");
    expect(sanitized.tripNumber).toBe("ABCD260912001");
    expect(sanitized.sendId).toBe("SEND-0001");
    const [entry] = sanitized.shipmentStatusList as Record<string, unknown>[];
    expect(entry?.shipmentControlNumber).toBe("1234PARS0001");
    expect(entry?.code).toBe("11");
  });

  it("shifts a wire-format date to a fixed epoch", () => {
    const sanitized = sanitizeInboundForFixture({
      data: "ACE_RESPONSE",
      cbpDateTime: "2026-09-13 14:32:07",
    }) as Record<string, unknown>;
    expect(sanitized.cbpDateTime).toBe("2026-01-01 00:00:00");
  });

  it("redacts an unlisted string field to <redacted:len=N>, and leaves that placeholder alone on re-sanitize", () => {
    const sanitized = sanitizeInboundForFixture({ description: "Arrival reported" }) as Record<
      string,
      unknown
    >;
    expect(sanitized.description).toBe("<redacted:len=16>");
    expect(sanitizeInboundForFixture(sanitized)).toEqual(sanitized);
  });

  it("passes through non-string scalars and null unchanged", () => {
    const sanitized = sanitizeInboundForFixture({
      autoSend: false,
      count: 3,
      note: null,
    }) as Record<string, unknown>;
    expect(sanitized).toEqual({ autoSend: false, count: 3, note: null });
  });
});
