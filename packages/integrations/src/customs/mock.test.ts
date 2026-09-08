import { describe, expect, it } from "vitest";
import { createCustomsClient } from "./index";
import { buildManifest, type ManifestSource } from "./manifest";
import { createMockCustomsClient } from "./mock";
import { CustomsTransportError, hasCustomsCredentials } from "./types";

const src: ManifestSource = {
  organization: {
    name: "Pathfinder",
    filerCode: "F01",
    usDotNumber: "1234567",
  },
  movement: {
    regime: "ACE",
    movementNumber: "ACE-26-00001",
    tripNumber: "TRIP-1",
    carrierCode: "PFTR",
    port: { code: "3801", name: "Detroit" },
    scheduledCrossingAt: "2026-09-08T14:00:00.000Z",
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
      hazmatEndorsement: true,
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
    {
      role: "passenger",
      firstName: "A",
      lastName: "R",
      gender: "F",
      licenseNumber: null,
      licenseJurisdiction: null,
      citizenship: "US",
      hazmatEndorsement: false,
      documents: [],
    },
  ],
  truck: {
    unitNumber: "T-101",
    vin: null,
    plateNumber: "AB1",
    plateJurisdiction: "ON",
    dotNumber: "1234567",
    insurancePolicyNumber: "POL-1",
    insuranceCompany: "Northbridge",
    insuranceAmount: 2000000,
    insuranceYear: 2026,
    plates: [{ plateNumber: "AB1-MI", jurisdiction: "MI" }],
    seals: ["S0"],
  },
  trailers: [
    {
      unitNumber: "TR-501",
      trailerType: "TF",
      plateNumber: "TRL1",
      plateJurisdiction: "ON",
      plates: [],
      seals: ["S1", "S2"],
    },
    {
      unitNumber: "TR-502",
      trailerType: "RT",
      plateNumber: "TRL2",
      plateJurisdiction: "ON",
      plates: [{ plateNumber: "TRL2-QC", jurisdiction: "QC" }],
      seals: ["S3"],
    },
  ],
  shipments: [
    {
      controlNumber: "PFTRPAPS0001",
      shipmentType: "regular_bill",
      cargoType: null,
      entryNumber: "ENT-1",
      entryPortCode: "3801",
      inBondEntryType: null,
      inBondDestinationPortCode: null,
      inBondNumber: null,
      shipperName: "A",
      shipperAddress: { line1: "1 Mill Rd", city: "Hamilton", region: "ON", country: "CA" },
      consigneeName: "B",
      consigneeAddress: null,
      commodities: [
        {
          commodityDescription: "Steel",
          hsCode: "7208.10",
          quantity: 2,
          quantityUnit: "Coil",
          weightKg: 100,
          marksAndNumbers: null,
          countryOfOrigin: "CA",
          valueAmount: 10,
          valueCurrency: "USD",
          hazmat: [{ unCode: "UN1203", description: "Gasoline" }],
        },
      ],
    },
  ],
};

const withTrip = (t: string | null) =>
  buildManifest({ ...src, movement: { ...src.movement, tripNumber: t } });
const fixedNow = () => new Date("2026-09-06T12:00:00.000Z");

describe("buildManifest", () => {
  it("maps movement → provider-neutral e-manifest", () => {
    const m = buildManifest(src);
    expect(m.trip.portOfEntry).toBe("3801");
    expect(m.crew.map((c) => c.role)).toEqual(["person_in_charge", "passenger"]);
    expect(m.crew[0]?.licenseNumber).toBe("L1");
    expect(m.crew[0]?.hazmatEndorsement).toBe(true);
    expect(m.crew[0]?.documents).toEqual([
      {
        type: "passport",
        number: "P123",
        issuingCountry: "CA",
        issuingState: null,
        expiresOn: "2030-01-01",
      },
    ]);
    expect(m.crew[1]?.gender).toBe("F");
    expect(m.trip.isEmpty).toBe(false);
    expect(m.conveyance.dotNumber).toBe("1234567");
    expect(m.conveyance.plates).toEqual([{ plate: "AB1-MI", jurisdiction: "MI" }]);
    expect(m.conveyance.insurance).toEqual({
      company: "Northbridge",
      policyNumber: "POL-1",
      amount: 2000000,
      year: 2026,
    });
    expect(m.conveyance.seals).toEqual(["S0"]);
    expect(m.equipment.map((e) => e.unitNumber)).toEqual(["TR-501", "TR-502"]);
    expect(m.equipment[0]?.type).toBe("TF");
    expect(m.equipment[0]?.seals).toEqual(["S1", "S2"]);
    expect(m.equipment[1]?.seals).toEqual(["S3"]);
    expect(m.equipment[1]?.plates).toEqual([{ plate: "TRL2-QC", jurisdiction: "QC" }]);
    expect(m.shipments[0]?.controlNumber).toBe("PFTRPAPS0001");
    expect(m.shipments[0]?.shipper).toEqual({
      name: "A",
      address: "1 Mill Rd, Hamilton, ON, CA",
    });
    expect(m.shipments[0]?.consignee).toEqual({ name: "B", address: null });
    expect(m.shipments[0]?.commodities[0]?.value).toEqual({ amount: 10, currency: "USD" });
    expect(m.shipments[0]?.commodities[0]?.hazmat).toEqual([
      { unCode: "UN1203", description: "Gasoline" },
    ]);
  });
  it("refuses incomplete movements", () => {
    expect(() => buildManifest({ ...src, crew: [] })).toThrow(/person in charge/);
    expect(() => buildManifest({ ...src, movement: { ...src.movement, port: null } })).toThrow(
      /port/,
    );
    expect(() =>
      buildManifest({ ...src, movement: { ...src.movement, carrierCode: null } }),
    ).toThrow(/carrier code/);
    expect(() => buildManifest({ ...src, shipments: [] })).toThrow(/shipment/);
    expect(() =>
      buildManifest({ ...src, movement: { ...src.movement, isEmpty: true } }),
    ).toThrow(/empty trip/);
  });
  it("files an empty trip with no shipments and no equipment", () => {
    const m = buildManifest({
      ...src,
      movement: { ...src.movement, isEmpty: true },
      shipments: [],
      trailers: [],
    });
    expect(m.trip.isEmpty).toBe(true);
    expect(m.equipment).toEqual([]);
  });
});

describe("mock customs client", () => {
  it("acknowledges with a stable, prefixed reference and the configured delay", async () => {
    const c = createMockCustomsClient({
      provider: "cbp_ace",
      mockDelayMs: 1234,
      now: fixedNow,
      random: () => 0.99,
    });
    const ack = await c.transmit(withTrip("TRIP-1"));
    expect(ack.referenceNumber).toMatch(/^ACE-[0-9A-Z]{7}$/);
    expect(ack.decisionEtaMs).toBe(1234);
    const again = await c.transmit(withTrip("TRIP-1"));
    expect(again.referenceNumber).toBe(ack.referenceNumber); // deterministic for same input+time
  });

  it("ACI prefix for CBSA", async () => {
    const c = createMockCustomsClient({ provider: "cbsa_aci", random: () => 0.99 });
    expect((await c.transmit(withTrip(null))).referenceNumber).toMatch(/^ACI-/);
  });

  it("FAIL / BADAUTH hooks and failure-rate injection throw transport errors", async () => {
    const c = createMockCustomsClient({ provider: "cbp_ace", random: () => 0.99 });
    await expect(c.transmit(withTrip("TRIP-FAIL-1"))).rejects.toMatchObject({
      statusCode: 503,
      retryable: true,
    });
    await expect(c.transmit(withTrip("BADAUTH"))).rejects.toBeInstanceOf(CustomsTransportError);
    await expect(c.transmit(withTrip("BADAUTH"))).rejects.toMatchObject({
      statusCode: 401,
      retryable: false,
    });
    const flaky = createMockCustomsClient({
      provider: "cbp_ace",
      mockFailureRate: 0.5,
      random: () => 0.1,
    });
    await expect(flaky.transmit(withTrip("OK"))).rejects.toMatchObject({ statusCode: 503 });
    const lucky = createMockCustomsClient({
      provider: "cbp_ace",
      mockFailureRate: 0.5,
      random: () => 0.9,
    });
    await expect(lucky.transmit(withTrip("OK"))).resolves.toBeTruthy();
  });

  it("emits the Avaal message sequence behind each decision", async () => {
    const c = createMockCustomsClient({ provider: "cbp_ace", now: fixedNow });
    const ok = withTrip("TRIP-OK");
    const accepted = await c.fetchDecision("R", ok, { currentStatus: "sent" });
    expect(accepted.events.map((e) => e.code)).toEqual([
      "sending",
      "preliminary_check_passed",
      "accepted",
    ]);
    expect(accepted.events[2]?.label).toBe("Accepted");
    expect(accepted.shipments).toEqual([{ controlNumber: "PFTRPAPS0001", status: "accepted" }]);

    const released = await c.fetchDecision("R", ok, { currentStatus: "accepted" });
    expect(released.events.map((e) => e.code)).toEqual([
      "entry_on_file",
      "arrival_recorded",
      "released",
    ]);
    expect(released.events[0]).toMatchObject({
      shipmentControlNumber: "PFTRPAPS0001",
      entryPortCode: "3801",
      entryNumber: expect.stringMatching(/^300\d{8}$/),
    });
    expect(released.shipments[0]).toMatchObject({
      controlNumber: "PFTRPAPS0001",
      status: "released",
      entryNumber: released.events[0]?.entryNumber,
    });
    // Deterministic: the same control number always gets the same entry number.
    const again = await c.fetchDecision("R", ok, { currentStatus: "accepted" });
    expect(again.shipments[0]?.entryNumber).toBe(released.shipments[0]?.entryNumber);

    const held = await c.fetchDecision("R", withTrip("TRIP-HOLD"), { currentStatus: "accepted" });
    expect(held.events.map((e) => e.code)).toEqual(["entry_on_file", "held"]);
    expect(held.shipments[0]?.status).toBe("held");
    const rejected = await c.fetchDecision("R", withTrip("TRIP-REJECT"), {
      currentStatus: "sent",
    });
    expect(rejected.events.map((e) => e.code)).toEqual(["sending", "rejected"]);

    const aci = createMockCustomsClient({ provider: "cbsa_aci", now: fixedNow });
    const rns = await aci.fetchDecision("R", { ...ok, regime: "ACI" }, { currentStatus: "accepted" });
    expect(rns.events.map((e) => e.code)).toEqual(["entered_and_released", "released"]);
  });

  it("decisions follow the trip hooks through the lifecycle", async () => {
    const c = createMockCustomsClient({ provider: "cbp_ace" });
    const ok = withTrip("TRIP-OK");
    expect((await c.fetchDecision("R", ok, { currentStatus: "sent" })).decision).toBe("accepted");
    expect((await c.fetchDecision("R", ok, { currentStatus: "accepted" })).decision).toBe(
      "released",
    );
    const rej = withTrip("TRIP-REJECT");
    expect((await c.fetchDecision("R", rej, { currentStatus: "sent" })).decision).toBe("rejected");
    const hold = withTrip("TRIP-HOLD");
    expect((await c.fetchDecision("R", hold, { currentStatus: "sent" })).decision).toBe("accepted");
    expect((await c.fetchDecision("R", hold, { currentStatus: "accepted" })).decision).toBe("held");
    expect((await c.fetchDecision("R", hold, { currentStatus: "held" })).decision).toBe("released");
  });
});

describe("vault-backed credentials", () => {
  it("hasCustomsCredentials ignores absent and blank fields", () => {
    expect(hasCustomsCredentials()).toBe(false);
    expect(hasCustomsCredentials({})).toBe(false);
    expect(hasCustomsCredentials({ apiKey: "" })).toBe(false);
    expect(hasCustomsCredentials({ accountId: "acct-1" })).toBe(true);
  });

  it("records only whether credentials were supplied — never their values", async () => {
    const withCreds = createMockCustomsClient({
      provider: "cbp_ace",
      random: () => 0.99,
      credentials: { apiKey: "super-secret", apiSecret: "also-secret" },
    });
    const ack = await withCreds.transmit(withTrip("TRIP-1"));
    expect(ack.raw.credentialsPresent).toBe(true);
    expect(JSON.stringify(ack.raw)).not.toContain("secret");

    const decision = await withCreds.fetchDecision("R", withTrip("TRIP-1"), {
      currentStatus: "sent",
    });
    expect(decision.raw.credentialsPresent).toBe(true);
    expect(JSON.stringify(decision.raw)).not.toContain("secret");
  });

  it("works unchanged when the org has stored no credentials", async () => {
    const bare = createMockCustomsClient({ provider: "cbp_ace", random: () => 0.99 });
    const ack = await bare.transmit(withTrip("TRIP-1"));
    expect(ack.raw.credentialsPresent).toBe(false);
    expect(ack.referenceNumber).toMatch(/^ACE-/);
  });

  it("createCustomsClient forwards credentials alongside settings", async () => {
    const client = createCustomsClient({
      regime: "ACI",
      environment: "production",
      settings: { mockDelayMs: 10, mockFailureRate: 0 },
      credentials: { accountId: "acct-1" },
    });
    const ack = await client.transmit(withTrip("TRIP-1"));
    expect(client.environment).toBe("production");
    expect(ack.decisionEtaMs).toBe(10);
    expect(ack.raw.credentialsPresent).toBe(true);
  });
});
