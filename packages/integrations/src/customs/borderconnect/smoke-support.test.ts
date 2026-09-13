import { describe, expect, it } from "vitest";
import { parseSmokeRegime, receiveShape, redactedSmokeRecord } from "./smoke-support";

describe("BorderConnect smoke evidence", () => {
  it("supports ACE and ACI regime flags and rejects anything else", () => {
    expect(parseSmokeRegime([])).toBe("ACE");
    expect(parseSmokeRegime(["--regime=aci"])).toBe("ACI");
    expect(parseSmokeRegime(["--regime", "ACE"])).toBe("ACE");
    expect(() => parseSmokeRegime(["--regime=unknown"])).toThrow(/ACE or ACI/);
  });

  it("classifies every receive envelope shape normalized by the transport", () => {
    expect(receiveShape(null)).toBe("empty");
    expect(receiveShape([])).toBe("array");
    expect(receiveShape({ messages: [] })).toBe("messages_envelope");
    expect(receiveShape({ data: "ACI_RESPONSE" })).toBe("single_message");
    expect(receiveShape({ status: "OK" })).toBe("unknown_object");
  });

  it("records status, shape, timestamps, and stable routing fingerprints without payload or keys", () => {
    const message = {
      data: "ACI_RESPONSE",
      status: "ACCEPT",
      companyKey: "private-company-key",
      sendId: "private-send-id",
      tripNumber: "PRIVATE-TRIP",
      driver: { firstName: "Jane", documentNumber: "P123" },
      shipment: { commodities: [{ description: "Private cargo" }] },
    };
    const first = redactedSmokeRecord({
      at: new Date("2026-09-13T12:00:00.000Z"),
      direction: "receive",
      regime: "ACI",
      message,
      shape: "single_message",
      httpStatus: 200,
    });
    const second = redactedSmokeRecord({
      at: new Date("2026-09-13T12:00:01.000Z"),
      direction: "receive",
      regime: "ACI",
      message,
    });
    const encoded = JSON.stringify(first);

    expect(first).toMatchObject({
      at: "2026-09-13T12:00:00.000Z",
      direction: "receive",
      regime: "ACI",
      receiveShape: "single_message",
      httpStatus: 200,
      envelope: { data: "ACI_RESPONSE", status: "ACCEPT" },
    });
    expect(first.routing.companyKey).toMatch(/^sha256:[a-f0-9]{12}$/);
    expect(first.routing).toEqual(second.routing);
    expect(encoded).not.toMatch(
      /private-company|private-send|PRIVATE-TRIP|Jane|P123|Private cargo/,
    );
  });
});
