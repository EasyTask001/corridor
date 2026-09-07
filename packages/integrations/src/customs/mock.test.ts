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
  },
  driver: {
    firstName: "G",
    lastName: "S",
    licenseNumber: "L1",
    licenseJurisdiction: "ON",
    citizenship: "CA",
    fastCardNumber: null,
  },
  truck: { unitNumber: "T-101", vin: null, plateNumber: "AB1", plateJurisdiction: "ON" },
  trailer: { unitNumber: "TR-501", plateNumber: "TRL1", plateJurisdiction: "ON" },
  seals: [{ sealNumber: "S1" }, { sealNumber: "S2" }],
  cargo: [
    {
      lineNumber: 1,
      shipperName: "A",
      consigneeName: "B",
      commodityDescription: "Steel",
      hsCode: "7208.10",
      weightKg: 100,
      pieceCount: 2,
      valueAmount: 10,
      valueCurrency: "USD",
      countryOfOrigin: "CA",
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
    expect(m.crew[0]?.licenseNumber).toBe("L1");
    expect(m.equipment[0]?.seals).toEqual(["S1", "S2"]);
    expect(m.shipments[0]?.value).toEqual({ amount: 10, currency: "USD" });
  });
  it("refuses incomplete movements", () => {
    expect(() => buildManifest({ ...src, driver: null })).toThrow(/driver/);
    expect(() =>
      buildManifest({ ...src, movement: { ...src.movement, port: null } }),
    ).toThrow(/port/);
    expect(() =>
      buildManifest({ ...src, movement: { ...src.movement, carrierCode: null } }),
    ).toThrow(/carrier code/);
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
