import { beforeEach, describe, expect, it } from "vitest";
import { createCustomsClient } from "../index";
import { buildManifest, type ManifestSource } from "../manifest";
import { clearCustomsFixtureState } from "../fixture-state";
import type { InBondMessage, ManifestPayload } from "../types";
import {
  createBorderConnectCustomsClient,
  createFixtureBorderConnectTransport,
} from "./client";
import type { BorderConnectTransport } from "./transport";

const fixedNow = () => new Date("2026-09-12T12:00:00.000Z");

/** A minimal, fully-valid ACE `ManifestSource` (passes `validateForBorderConnect`). */
function makeAceSource(): ManifestSource {
  return {
    organization: {
      name: "Pathfinder",
      usDotNumber: "1234567",
      filerCode: "F01",
      scacCode: "PFTR",
      canadianCarrierCode: "1234567",
      timezone: "America/Toronto",
    },
    movement: {
      regime: "ACE",
      movementNumber: "ACE-26-00001",
      tripNumber: "PFTR00001",
      carrierCode: "PFTR",
      port: { code: "3801" },
      scheduledCrossingAt: "2026-09-08T14:37:00.000Z",
      isEmpty: false,
      iitIndicator: "none",
      aciLvs: false,
      aciPostal: false,
      aciFlyingTruck: false,
      aciInTransit: false,
      aciIit: false,
    },
    crew: [
      {
        role: "person_in_charge",
        firstName: "G",
        lastName: "S",
        gender: "M",
        licenseNumber: "L1",
        licenseJurisdiction: "ON",
        citizenship: "CA",
        dateOfBirth: "1985-03-14",
        hazmatEndorsement: false,
        documents: [
          {
            documentType: "passport",
            documentNumber: "P123",
            issuingCountry: "CA",
            issuingState: null,
            expiresOn: "2030-01-01",
          },
        ],
      },
    ],
    truck: {
      unitNumber: "T-101",
      vin: "1FUJA6CV12LJ12345",
      plateNumber: "AB1",
      plateJurisdiction: "ON",
      dotNumber: null,
      truckType: "TR",
      insurancePolicyNumber: null,
      insuranceCompany: null,
      insuranceAmount: null,
      insuranceYear: null,
      plates: [],
      seals: [],
    },
    trailers: [
      {
        unitNumber: "TR-1",
        trailerType: "TF",
        plateNumber: "GH4",
        plateJurisdiction: "ON",
        plates: [],
        seals: [],
      },
    ],
    shipments: [
      {
        controlNumber: "PFTRPAPS0001",
        shipmentType: "regular_bill",
        cargoType: null,
        entryNumber: null,
        entryPortCode: "3801",
        inBondEntryType: null,
        inBondDestinationPortCode: null,
        inBondNumber: null,
        loadingCountry: "CA",
        loadingProvince: "ON",
        loadingCity: "Hamilton",
        deliveryAddress: null,
        shipperName: "Acme Steel",
        shipperAddress: {
          line1: "1 Mill Rd",
          city: "Hamilton",
          region: "ON",
          postalCode: "L8L1A1",
          country: "CA",
        },
        consigneeName: "Depot Inc",
        consigneeAddress: {
          line1: "2 Depot Ave",
          city: "Detroit",
          region: "MI",
          postalCode: "48201",
          country: "US",
        },
        commodities: [
          {
            commodityDescription: "Steel Coil",
            hsCode: "7208.10",
            quantity: 2,
            quantityUnit: "Coil",
            weightKg: 1000,
            weightUnit: "KG",
            packagingType: "Skid",
            marksAndNumbers: null,
            countryOfOrigin: "CA",
            valueAmount: 5000,
            valueCurrency: "USD",
            hazmat: [],
          },
        ],
      },
    ],
  };
}

/** A minimal, fully-valid ACI `ManifestSource`. */
function makeAciSource(): ManifestSource {
  return {
    organization: {
      name: "Pathfinder",
      usDotNumber: "1234567",
      filerCode: "F01",
      scacCode: "PFTR",
      canadianCarrierCode: "1234567",
      timezone: "America/Toronto",
    },
    movement: {
      regime: "ACI",
      movementNumber: "ACI-26-00007",
      tripNumber: "PFTR00007",
      carrierCode: "PFTR",
      port: { code: "0409" },
      scheduledCrossingAt: "2026-09-08T20:00:00.000Z",
      isEmpty: false,
      iitIndicator: "none",
      aciLvs: false,
      aciPostal: false,
      aciFlyingTruck: false,
      aciInTransit: false,
      aciIit: false,
    },
    crew: [
      {
        role: "person_in_charge",
        firstName: "H",
        lastName: "D",
        gender: "M",
        licenseNumber: "L9",
        licenseJurisdiction: "ON",
        citizenship: "CA",
        dateOfBirth: "1980-01-01",
        hazmatEndorsement: false,
        documents: [
          {
            documentType: "passport",
            documentNumber: "P999",
            issuingCountry: "CA",
            issuingState: null,
            expiresOn: "2029-01-01",
          },
        ],
      },
    ],
    truck: {
      unitNumber: "T-201",
      vin: "2FUJA6CV12LJ99999",
      plateNumber: "AB9",
      plateJurisdiction: "ON",
      dotNumber: null,
      truckType: "TR",
      insurancePolicyNumber: null,
      insuranceCompany: null,
      insuranceAmount: null,
      insuranceYear: null,
      plates: [],
      seals: [],
    },
    trailers: [
      {
        unitNumber: "TR-2",
        trailerType: "RT",
        plateNumber: "GH9",
        plateJurisdiction: "ON",
        plates: [],
        seals: [],
      },
    ],
    shipments: [
      {
        controlNumber: "PFTRCSA00001",
        shipmentType: null,
        cargoType: "csa",
        entryNumber: null,
        entryPortCode: "0409",
        inBondEntryType: null,
        inBondDestinationPortCode: null,
        inBondNumber: null,
        loadingCountry: "CA",
        loadingProvince: "ON",
        loadingCity: "Hamilton",
        deliveryAddress: null,
        shipperName: "Acme Steel",
        shipperAddress: {
          line1: "1 Mill Rd",
          city: "Hamilton",
          region: "ON",
          postalCode: "L8L1A1",
          country: "CA",
        },
        consigneeName: "Depot Inc",
        consigneeAddress: {
          line1: "2 Depot Ave",
          city: "Detroit",
          region: "MI",
          postalCode: "48201",
          country: "US",
        },
        commodities: [
          {
            commodityDescription: "Steel Coil",
            hsCode: "7208.10",
            quantity: 2,
            quantityUnit: "Coil",
            weightKg: 1000,
            weightUnit: "KG",
            packagingType: "Skid",
            marksAndNumbers: null,
            countryOfOrigin: "CA",
            valueAmount: 5000,
            valueCurrency: "USD",
            hazmat: [],
          },
        ],
      },
    ],
  };
}

function withControlNumber(payload: ManifestPayload, controlNumber: string): ManifestPayload {
  return { ...payload, shipments: [{ ...payload.shipments[0]!, controlNumber }] };
}

/** Records every message a client sends, and answers `{status:"OK"}` / no queued inbound. */
function spyTransport(): { calls: Record<string, unknown>[]; transport: BorderConnectTransport } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    transport: {
      send: (message) => {
        calls.push(message);
        return Promise.resolve({ status: "OK" });
      },
      receive: () => Promise.resolve([]),
    },
  };
}

beforeEach(clearCustomsFixtureState);

describe("createBorderConnectCustomsClient — transmit", () => {
  it("returns the trip number as the reference and the send id in raw", async () => {
    const c = createBorderConnectCustomsClient({
      provider: "cbp_ace",
      apiUrlSuffix: null,
      apiKey: null,
      companyKey: null,
      tenantKey: "t1",
      now: fixedNow,
    });
    expect(c.mode).toBe("border_connect");
    expect(c.live).toBe(false);
    const manifest = buildManifest(makeAceSource());
    const ack = await c.transmit(manifest, { correlationId: "corr-1" });
    expect(ack.referenceNumber).toBe("PFTR00001");
    expect(ack.receivedAt).toBe(fixedNow().toISOString());
    expect(ack.raw).toMatchObject({ borderConnect: true, live: false, sendId: "corr-1" });
  });

  it("generates a sendId when no correlationId is given", async () => {
    const { calls, transport } = spyTransport();
    const c = createBorderConnectCustomsClient({
      provider: "cbp_ace",
      apiUrlSuffix: null,
      apiKey: null,
      companyKey: "CK1",
      tenantKey: "t1",
      now: fixedNow,
      transport,
    });
    await c.transmit(buildManifest(makeAceSource()));
    expect(typeof calls[0]?.sendId).toBe("string");
    expect((calls[0]?.sendId as string).length).toBeGreaterThan(0);
  });
});

describe("createBorderConnectCustomsClient — amend", () => {
  it("re-uploads under the trip already on file with operation UPDATE", async () => {
    const { calls, transport } = spyTransport();
    const c = createBorderConnectCustomsClient({
      provider: "cbp_ace",
      apiUrlSuffix: null,
      apiKey: null,
      companyKey: "CK1",
      tenantKey: "t1",
      now: fixedNow,
      transport,
    });
    const manifest = buildManifest(makeAceSource());
    await c.transmit(manifest);
    expect(calls[0]).toMatchObject({ operation: "CREATE", tripNumber: "PFTR00001" });

    const amended = await c.amend(manifest, "ACE-ORIGINAL-REF");
    expect(calls[1]).toMatchObject({ operation: "UPDATE", tripNumber: "ACE-ORIGINAL-REF" });
    expect(amended.referenceNumber).toBe("ACE-ORIGINAL-REF");
  });
});

describe("createBorderConnectCustomsClient — cancel", () => {
  it("sends ACE_SEND_REQUEST CANCEL_TRIP_AND_SHIPMENTS for ACE", async () => {
    const { calls, transport } = spyTransport();
    const c = createBorderConnectCustomsClient({
      provider: "cbp_ace",
      apiUrlSuffix: null,
      apiKey: null,
      companyKey: "CK1",
      tenantKey: "t1",
      now: fixedNow,
      transport,
    });
    const ack = await c.cancel("ABCD260912001", "Load cancelled");
    expect(calls[0]).toMatchObject({
      data: "ACE_SEND_REQUEST",
      type: "CANCEL_TRIP_AND_SHIPMENTS",
      tripNumber: "ABCD260912001",
      companyKey: "CK1",
    });
    expect(ack.referenceNumber).toBe("ABCD260912001");
  });

  it("sends ACI_SEND_REQUEST CANCEL with bundleTripAndShipments for ACI", async () => {
    const { calls, transport } = spyTransport();
    const c = createBorderConnectCustomsClient({
      provider: "cbsa_aci",
      apiUrlSuffix: null,
      apiKey: null,
      companyKey: "CK1",
      tenantKey: "t2",
      now: fixedNow,
      transport,
    });
    await c.cancel("ABCD260912002", null);
    expect(calls[0]).toMatchObject({
      data: "ACI_SEND_REQUEST",
      type: "CANCEL",
      bundleTripAndShipments: true,
      tripNumber: "ABCD260912002",
      companyKey: "CK1",
    });
  });
});

describe("fixture replay — ACE", () => {
  it("enqueues API_RESPONSE IMPORTED then the accepted/held/rejected ACE_RESPONSE, keyed on the control-number suffix", async () => {
    const transport = createFixtureBorderConnectTransport("t1", fixedNow);
    const c = createBorderConnectCustomsClient({
      provider: "cbp_ace",
      apiUrlSuffix: null,
      apiKey: null,
      companyKey: null,
      tenantKey: "t1",
      now: fixedNow,
      transport,
    });

    const accepted = await c.transmit(buildManifest(makeAceSource()));
    let messages = await transport.receive();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      data: "API_RESPONSE",
      status: "IMPORTED",
      tripNumber: accepted.referenceNumber,
    });
    expect(messages[1]).toMatchObject({
      data: "ACE_RESPONSE",
      processingResponse: { code: "AA" },
      tripNumber: accepted.referenceNumber,
    });
    expect(await transport.receive()).toEqual([]); // drained

    const held = await c.transmit(withControlNumber(buildManifest(makeAceSource()), "PFTRPAPS000H"));
    messages = await transport.receive();
    expect(messages[1]).toMatchObject({
      data: "ACE_RESPONSE",
      tripStatus: "HTR",
      tripNumber: held.referenceNumber,
    });

    const rejected = await c.transmit(withControlNumber(buildManifest(makeAceSource()), "PFTRPAPS000R"));
    messages = await transport.receive();
    expect(messages[1]).toMatchObject({
      data: "ACE_RESPONSE",
      validationResponses: expect.any(Array),
      tripNumber: rejected.referenceNumber,
    });
  });

  it("cancel enqueues API_RESPONSE TRANSMITTED", async () => {
    const transport = createFixtureBorderConnectTransport("t1", fixedNow);
    const c = createBorderConnectCustomsClient({
      provider: "cbp_ace",
      apiUrlSuffix: null,
      apiKey: null,
      companyKey: null,
      tenantKey: "t1",
      now: fixedNow,
      transport,
    });
    await c.cancel("PFTR00001", "Load cancelled");
    const messages = await transport.receive();
    expect(messages).toEqual([
      expect.objectContaining({ data: "API_RESPONSE", status: "TRANSMITTED", tripNumber: "PFTR00001" }),
    ]);
  });
});

describe("fixture replay — ACI", () => {
  it("enqueues API_RESPONSE IMPORTED then ACCEPT/ACI_NOTICE/REJECT, keyed on the control-number suffix", async () => {
    const transport = createFixtureBorderConnectTransport("t2", fixedNow);
    const c = createBorderConnectCustomsClient({
      provider: "cbsa_aci",
      apiUrlSuffix: null,
      apiKey: null,
      companyKey: null,
      tenantKey: "t2",
      now: fixedNow,
      transport,
    });

    const accepted = await c.transmit(buildManifest(makeAciSource()));
    let messages = await transport.receive();
    expect(messages[1]).toMatchObject({
      data: "ACI_RESPONSE",
      type: "ACCEPT",
      tripNumber: accepted.referenceNumber,
    });

    const held = await c.transmit(withControlNumber(buildManifest(makeAciSource()), "PFTRCSA0000H"));
    messages = await transport.receive();
    expect(messages[1]).toMatchObject({
      data: "ACI_NOTICE",
      type: "INSUFFICIENT_REVIEW_TIME_WARNING",
      tripNumber: held.referenceNumber,
    });

    const rejected = await c.transmit(withControlNumber(buildManifest(makeAciSource()), "PFTRCSA0000R"));
    messages = await transport.receive();
    expect(messages[1]).toMatchObject({
      data: "ACI_RESPONSE",
      type: "REJECT",
      tripNumber: rejected.referenceNumber,
    });
  });
});

describe("createBorderConnectCustomsClient — unsupported methods", () => {
  it("fetchStatus/fetchDecision/fetchNotices/inBond* each throw a 501 naming themselves", async () => {
    const c = createBorderConnectCustomsClient({
      provider: "cbp_ace",
      apiUrlSuffix: null,
      apiKey: null,
      companyKey: null,
      tenantKey: "t1",
      now: fixedNow,
    });
    const manifest = buildManifest(makeAceSource());
    const rec: InBondMessage = {
      bondNumber: "123456789",
      entryType: "IT",
      arrivalPortCode: "3801",
      exportPortCode: "0901",
      firmsCode: "A123",
      carrierCode: "PFTR",
      controlNumber: "PFTRPAPS0001",
    };
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["fetchStatus", () => c.fetchStatus("REF")],
      ["fetchDecision", () => c.fetchDecision("REF", manifest, { currentStatus: "sent" })],
      ["fetchNotices", () => c.fetchNotices(null)],
      ["inBondArrival", () => c.inBondArrival(rec)],
      ["inBondExport", () => c.inBondExport(rec)],
      ["inBondCancel", () => c.inBondCancel(rec, "reason")],
      ["inBondStatus", () => c.inBondStatus(rec.bondNumber)],
    ];
    for (const [name, call] of calls) {
      await expect(call()).rejects.toMatchObject({
        name: "CustomsTransportError",
        statusCode: 501,
        retryable: false,
        message: expect.stringContaining(name),
      });
    }
  });

  it("parseInbound always returns null (no signed webhook in this mode)", () => {
    const c = createBorderConnectCustomsClient({
      provider: "cbp_ace",
      apiUrlSuffix: null,
      apiKey: null,
      companyKey: null,
      tenantKey: "t1",
      now: fixedNow,
    });
    expect(c.parseInbound("{}", { get: () => null }, "secret")).toBeNull();
  });
});

describe("createBorderConnectCustomsClient — ping", () => {
  it("drains the queue and reports the message count", async () => {
    const transport = createFixtureBorderConnectTransport("t1", fixedNow);
    const c = createBorderConnectCustomsClient({
      provider: "cbp_ace",
      apiUrlSuffix: null,
      apiKey: null,
      companyKey: null,
      tenantKey: "t1",
      now: fixedNow,
      transport,
    });
    await c.transmit(buildManifest(makeAceSource()));
    const result = await c.ping();
    expect(result).toMatchObject({ ok: true, mode: "border_connect", live: false, detail: { messages: 2 } });
    expect((await c.ping()).detail).toEqual({ messages: 0 });
  });
});

describe("createBorderConnectCustomsClient — live mode", () => {
  it("sends the configured companyKey", async () => {
    const { calls, transport } = spyTransport();
    const c = createBorderConnectCustomsClient({
      provider: "cbp_ace",
      apiUrlSuffix: "acme",
      apiKey: "API-KEY-1",
      companyKey: "CK-LIVE",
      tenantKey: "t1",
      now: fixedNow,
      transport,
    });
    expect(c.live).toBe(true);
    await c.transmit(buildManifest(makeAceSource()));
    expect(calls[0]).toMatchObject({ companyKey: "CK-LIVE" });
  });

  it("refuses to transmit with companyKey: null", async () => {
    const { transport } = spyTransport();
    const c = createBorderConnectCustomsClient({
      provider: "cbp_ace",
      apiUrlSuffix: "acme",
      apiKey: "API-KEY-1",
      companyKey: null,
      tenantKey: "t1",
      now: fixedNow,
      transport,
    });
    expect(c.live).toBe(true);
    await expect(c.transmit(buildManifest(makeAceSource()))).rejects.toMatchObject({
      name: "CustomsTransportError",
      statusCode: 422,
    });
  });
});

describe("createCustomsClient wiring", () => {
  it("mode: 'border_connect' resolves to the BorderConnect client", () => {
    const c = createCustomsClient({ regime: "ACE", mode: "border_connect", tenantKey: "t1" });
    expect(c.mode).toBe("border_connect");
    expect(c.provider).toBe("cbp_ace");
  });
});
