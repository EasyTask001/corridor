import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inboundKeys, parseInbound } from "./inbound";

const here = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, "fixtures", "inbound", `${name}.json`), "utf8"));
}

const COMPANY_KEY = "c-9000-2bcd8ae5954e0c48";
const TRIP_NUMBER = "ABCD260912001";
const CCN = "1234PARS0001";

describe("parseInbound — API_RESPONSE", () => {
  it("OK/QUEUED/IMPORTED/TRANSMITTED/COMPLETED status → kind api_response, ok:true", () => {
    const msg = parseInbound(loadFixture("api-response-ok"));
    expect(msg.kind).toBe("api_response");
    if (msg.kind !== "api_response") throw new Error("wrong kind");
    expect(msg.companyKey).toBe(COMPANY_KEY);
    expect(msg.sendId).toBe("SEND-0001");
    expect(msg.tripNumber).toBe(TRIP_NUMBER);
    expect(msg.ok).toBe(true);
    expect(msg.status).toBe("COMPLETED");
    expect(msg.errors).toEqual([]);
  });

  it("DATA_ERROR/SEND_ERROR/SYNC_ERROR/ACCESS_DENIED_ERROR/IMPORTED_WITH_ERRORS/PROCESSED_WITH_ERRORS → ok:false, message joined from errors[]", () => {
    const msg = parseInbound(loadFixture("api-response-error"));
    expect(msg.kind).toBe("api_response");
    if (msg.kind !== "api_response") throw new Error("wrong kind");
    expect(msg.ok).toBe(false);
    expect(msg.status).toBe("DATA_ERROR");
    expect(msg.errors).toEqual([
      "shipments[0].consignee.name: required field is missing",
      "truck.vinNumber: invalid format",
    ]);
    expect(msg.message).toBe(
      "shipments[0].consignee.name: required field is missing; truck.vinNumber: invalid format",
    );
  });
});

describe("parseInbound — ACE_RESPONSE", () => {
  it("validationResponses[] non-empty → rejected, one rejected event per entry (code – description)", () => {
    const msg = parseInbound(loadFixture("ace-response-validation-errors"));
    expect(msg.kind).toBe("customs_status");
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.status).toBe("rejected");
    expect(msg.status.decision).toBe("rejected");
    expect(msg.status.referenceNumber).toBe(TRIP_NUMBER);
    expect(msg.status.events.map((e) => e.code)).toEqual(["rejected", "rejected"]);
    expect(msg.status.events.map((e) => e.label)).toEqual([
      "E203 – Shipment control number already on file",
      "E410 – Missing shipper address",
    ]);
    expect(msg.keys).toEqual({ tripNumber: TRIP_NUMBER });
  });

  it("processingResponse with no validation errors → accepted", () => {
    const msg = parseInbound(loadFixture("ace-response-processing-accepted"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.status).toBe("accepted");
    expect(msg.status.decision).toBe("accepted");
    expect(msg.status.events.map((e) => e.code)).toEqual(["accepted"]);
  });

  it("tripStatus AAD/19 → decision null, arrival_recorded event only", () => {
    const msg = parseInbound(loadFixture("ace-response-trip-status-arrival"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.decision).toBeNull();
    expect(msg.status.events.map((e) => e.code)).toEqual(["arrival_recorded"]);
  });

  it("tripStatus RTR/RCO → released", () => {
    const msg = parseInbound(loadFixture("ace-response-trip-status-released"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.status).toBe("released");
    expect(msg.status.decision).toBe("released");
    expect(msg.status.events.map((e) => e.code)).toEqual(["released"]);
  });

  it("tripStatus HTR → held", () => {
    const msg = parseInbound(loadFixture("ace-response-trip-status-held"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.status).toBe("held");
    expect(msg.status.decision).toBe("held");
    expect(msg.status.events.map((e) => e.code)).toEqual(["held"]);
  });

  it("shipmentStatusList[] code 02/05 (+entryNumber) → entry_on_file event only, carrying shipmentControlNumber/entryNumber/port", () => {
    const msg = parseInbound(loadFixture("ace-response-shipment-entry-on-file"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.decision).toBeNull();
    expect(msg.status.events).toHaveLength(1);
    const event = msg.status.events[0]!;
    expect(event.code).toBe("entry_on_file");
    expect(event.shipmentControlNumber).toBe(CCN);
    expect(event.entryNumber).toBe("816-1234567-8");
    expect(event.entryPortCode).toBe("0901");
    expect(msg.status.shipments).toEqual([]);
    expect(msg.keys).toEqual({ tripNumber: TRIP_NUMBER });
  });

  it("code 1C → entered_and_released event, shipments[] status released", () => {
    const msg = parseInbound(loadFixture("ace-response-shipment-entered-released"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.events.map((e) => e.code)).toEqual(["entered_and_released"]);
    expect(msg.status.shipments).toEqual([
      { controlNumber: CCN, status: "released", entryNumber: "816-1234567-8", entryPortCode: "0901" },
    ]);
  });

  it("code 1G/1H → held", () => {
    const msg = parseInbound(loadFixture("ace-response-shipment-held"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.status).toBe("held");
    expect(msg.status.decision).toBe("held");
    expect(msg.status.events.map((e) => e.code)).toEqual(["held"]);
  });

  it("code 11/12/13/19 → arrival_recorded event only", () => {
    const msg = parseInbound(loadFixture("ace-response-shipment-arrival"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.decision).toBeNull();
    expect(msg.status.events.map((e) => e.code)).toEqual(["arrival_recorded"]);
  });

  it("code 1D → entry_on_file event only", () => {
    const msg = parseInbound(loadFixture("ace-response-shipment-entry-on-file-1d"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.decision).toBeNull();
    expect(msg.status.events.map((e) => e.code)).toEqual(["entry_on_file"]);
  });

  it("other codes → preliminary_check_passed with raw code/description in raw", () => {
    const msg = parseInbound(loadFixture("ace-response-shipment-other-code"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.decision).toBeNull();
    expect(msg.status.events.map((e) => e.code)).toEqual(["preliminary_check_passed"]);
    expect(msg.status.events[0]!.raw).toMatchObject({ code: "01", description: "Preliminary manifest check passed" });
  });

  it("processingResponse + shipmentStatusList 1G in the same message → held, both events kept", () => {
    const msg = parseInbound({
      data: "ACE_RESPONSE",
      tripNumber: TRIP_NUMBER,
      processingResponse: { status: "OK" },
      shipmentStatusList: [{ code: "1G", shipmentControlNumber: CCN }],
    });
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.status).toBe("held");
    expect(msg.status.decision).toBe("held");
    expect(msg.status.events.map((e) => e.code)).toEqual(["accepted", "held"]);
  });

  it("processingResponse + shipmentStatusList 1C in the same message → accepted, shipment released", () => {
    const msg = parseInbound({
      data: "ACE_RESPONSE",
      tripNumber: TRIP_NUMBER,
      processingResponse: { status: "OK" },
      shipmentStatusList: [{ code: "1C", shipmentControlNumber: CCN, entryNumber: "816-1234567-8" }],
    });
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.status).toBe("accepted");
    expect(msg.status.decision).toBe("accepted");
    expect(msg.status.events.map((e) => e.code)).toEqual(["accepted", "entered_and_released"]);
    expect(msg.status.shipments).toEqual([
      { controlNumber: CCN, status: "released", entryNumber: "816-1234567-8", entryPortCode: null },
    ]);
  });
});

describe("parseInbound — ACI_RESPONSE", () => {
  it("type ACCEPT → accepted", () => {
    const msg = parseInbound(loadFixture("aci-response-accept"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.status).toBe("accepted");
    expect(msg.status.decision).toBe("accepted");
    expect(msg.status.events.map((e) => e.code)).toEqual(["accepted"]);
    expect(msg.keys).toEqual({ tripNumber: TRIP_NUMBER });
  });

  it("type REJECT → rejected, message joined from errorResponses[]", () => {
    const msg = parseInbound(loadFixture("aci-response-reject"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.status).toBe("rejected");
    expect(msg.status.decision).toBe("rejected");
    expect(msg.status.message).toBe("E100 shipment.consignee: Missing consignee name");
    expect(msg.status.events.map((e) => e.code)).toEqual(["rejected"]);
    expect(msg.keys).toEqual({ tripNumber: TRIP_NUMBER });
  });
});

describe("parseInbound — ACI_NOTICE", () => {
  it("type ARRIVAL_REPORTED → arrival_recorded, one event per references[] CCN", () => {
    const msg = parseInbound(loadFixture("aci-notice-arrival-reported"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.decision).toBeNull();
    expect(msg.status.events.map((e) => e.code)).toEqual(["arrival_recorded"]);
    expect(msg.status.events[0]!.shipmentControlNumber).toBe(CCN);
    expect(msg.keys).toEqual({ tripNumber: TRIP_NUMBER, cargoControlNumber: CCN });
  });

  it("type MATCHED → pars_matched, keys carry only the CCN (no tripNumber on this message)", () => {
    const msg = parseInbound(loadFixture("aci-notice-matched"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.events.map((e) => e.code)).toEqual(["pars_matched"]);
    expect(msg.keys).toEqual({ cargoControlNumber: CCN });
    expect(msg.keys.tripNumber).toBeUndefined();
  });

  it("type NOT_MATCHED → pars_not_matched, keys carry only the CCN", () => {
    const msg = parseInbound(loadFixture("aci-notice-not-matched"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.events.map((e) => e.code)).toEqual(["pars_not_matched"]);
    expect(msg.keys).toEqual({ cargoControlNumber: CCN });
    expect(msg.keys.tripNumber).toBeUndefined();
  });

  it("type CSA_REPORTED → csa_reported, keys carry only the CCN", () => {
    const msg = parseInbound(loadFixture("aci-notice-csa-reported"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.events.map((e) => e.code)).toEqual(["csa_reported"]);
    expect(msg.keys).toEqual({ cargoControlNumber: CCN });
    expect(msg.keys.tripNumber).toBeUndefined();
  });

  it("type INSUFFICIENT_REVIEW_TIME_WARNING → review_time_warning, keys carry only the CCN", () => {
    const msg = parseInbound(loadFixture("aci-notice-review-time-warning"));
    if (msg.kind !== "customs_status") throw new Error("wrong kind");
    expect(msg.status.events.map((e) => e.code)).toEqual(["review_time_warning"]);
    expect(msg.keys).toEqual({ cargoControlNumber: CCN });
    expect(msg.keys.tripNumber).toBeUndefined();
  });
});

describe("parseInbound — RNS_SHIPMENT and SYSTEM_ALERT", () => {
  it("RNS_SHIPMENT → kind rns", () => {
    const msg = parseInbound(loadFixture("rns-shipment"));
    expect(msg.kind).toBe("rns");
    if (msg.kind !== "rns") throw new Error("wrong kind");
    expect(msg.cargoControlNumber).toBe(CCN);
    expect(msg.transactionNumber).toBe("816-1234567-8");
    expect(msg.releaseCode).toBe("4");
    expect(msg.releaseName).toBe("Released");
    expect(msg.officeCode).toBe("0901");
    expect(msg.releasedAt).toBe("2026-09-12T11:00:00.000Z");
  });

  it("SYSTEM_ALERT → kind alert", () => {
    const msg = parseInbound(loadFixture("system-alert"));
    expect(msg.kind).toBe("alert");
    if (msg.kind !== "alert") throw new Error("wrong kind");
    expect(msg.message).toBe("Scheduled maintenance window 2026-09-13 02:00-04:00 ET");
  });
});

describe("parseInbound — unknown / malformed", () => {
  it("unknown data type is preserved as kind:\"unknown\"", () => {
    const msg = parseInbound({ data: "SOME_NEW_MESSAGE_TYPE", companyKey: COMPANY_KEY });
    expect(msg.kind).toBe("unknown");
    if (msg.kind !== "unknown") throw new Error("wrong kind");
    expect(msg.dataType).toBe("SOME_NEW_MESSAGE_TYPE");
    expect(msg.companyKey).toBe(COMPANY_KEY);
  });

  it("missing data field → unknown", () => {
    const msg = parseInbound({ tripNumber: TRIP_NUMBER });
    expect(msg.kind).toBe("unknown");
  });

  it("companyKey null when absent", () => {
    const msg = parseInbound({ data: "SYSTEM_ALERT", message: "no company key here" });
    if (msg.kind !== "alert") throw new Error("wrong kind");
    // alert kind carries no companyKey field, so assert via a kind that does:
    const withoutKey = parseInbound({ data: "API_RESPONSE", status: "COMPLETED", errors: [] });
    if (withoutKey.kind !== "api_response") throw new Error("wrong kind");
    expect(withoutKey.companyKey).toBeNull();
  });

  it("does not throw on completely malformed input", () => {
    expect(() => parseInbound(null)).not.toThrow();
    expect(() => parseInbound(undefined)).not.toThrow();
    expect(() => parseInbound("a string")).not.toThrow();
    expect(() => parseInbound([1, 2, 3])).not.toThrow();
    expect(parseInbound(null).kind).toBe("unknown");
  });
});

describe("inboundKeys", () => {
  it("extracts routing keys from an ACE_RESPONSE message", () => {
    const keys = inboundKeys(loadFixture("ace-response-validation-errors"));
    expect(keys).toEqual({
      dataType: "ACE_RESPONSE",
      companyKey: COMPANY_KEY,
      sendId: null,
      tripNumber: TRIP_NUMBER,
      cargoControlNumber: null,
      shipmentControlNumber: null,
    });
  });

  it("extracts routing keys from an RNS_SHIPMENT message (cargoControlNumber, no tripNumber)", () => {
    const keys = inboundKeys(loadFixture("rns-shipment"));
    expect(keys.dataType).toBe("RNS_SHIPMENT");
    expect(keys.cargoControlNumber).toBe(CCN);
    expect(keys.tripNumber).toBeNull();
    expect(keys.companyKey).toBeNull();
  });

  it("extracts sendId from an API_RESPONSE message", () => {
    const keys = inboundKeys(loadFixture("api-response-ok"));
    expect(keys.sendId).toBe("SEND-0001");
    expect(keys.companyKey).toBe(COMPANY_KEY);
  });

  it("does not throw on malformed input", () => {
    expect(inboundKeys(null)).toEqual({
      dataType: "",
      companyKey: null,
      sendId: null,
      tripNumber: null,
      cargoControlNumber: null,
      shipmentControlNumber: null,
    });
  });
});
