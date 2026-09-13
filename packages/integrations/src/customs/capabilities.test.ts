import { describe, expect, it } from "vitest";
import { resolveCustomsCapabilities } from "./capabilities";

describe("resolveCustomsCapabilities — mock", () => {
  it("everything is available", () => {
    const c = resolveCustomsCapabilities({
      regime: "ACE",
      mode: "mock",
      environment: "production",
    });
    expect(c).toMatchObject({
      transmit: true,
      amend: true,
      cancel: true,
      status: true,
      inBond: true,
      multiTrailer: true,
      emptyTrip: true,
      reasons: {},
    });
  });
});

describe("resolveCustomsCapabilities — gateway", () => {
  it("is available in production once a base URL and a key/credential are set", () => {
    const c = resolveCustomsCapabilities({
      regime: "ACE",
      mode: "gateway",
      environment: "production",
      baseUrl: "https://gateway.example",
      apiKey: "k",
    });
    expect(c.transmit).toBe(true);
    expect(c.multiTrailer).toBe(true);
    expect(c.emptyTrip).toBe(true);
  });

  it("fails closed in production when unconfigured", () => {
    const c = resolveCustomsCapabilities({ regime: "ACE", mode: "gateway", environment: "production" });
    expect(c.transmit).toBe(false);
    expect(c.multiTrailer).toBe(false);
    expect(c.emptyTrip).toBe(false);
    expect(c.reasons.emptyTrip).toMatch(/not configured/i);
  });

  it("is available in sandbox even when unconfigured", () => {
    const c = resolveCustomsCapabilities({ regime: "ACE", mode: "gateway", environment: "sandbox" });
    expect(c.transmit).toBe(true);
    expect(c.emptyTrip).toBe(true);
  });
});

describe("resolveCustomsCapabilities — border_connect", () => {
  const configured = {
    apiUrlSuffix: "service-provider",
    apiKey: "secret",
    companyKey: "CK1",
  };

  it("fails closed in production when unconfigured, with distinct reasons per capability", () => {
    const c = resolveCustomsCapabilities({
      regime: "ACE",
      mode: "border_connect",
      environment: "production",
    });
    expect(c.transmit).toBe(false);
    expect(c.multiTrailer).toBe(false);
    expect(c.emptyTrip).toBe(false);
    expect(c.reasons.status).toMatch(/shared BorderConnect inbox/);
    expect(c.reasons.inBond).toMatch(/QP In-Bond/);
  });

  it("ACE amend is always available once configured; ACI amend needs the flag in production", () => {
    const ace = resolveCustomsCapabilities({
      regime: "ACE",
      mode: "border_connect",
      environment: "production",
      ...configured,
    });
    expect(ace.amend).toBe(true);

    const aciProd = resolveCustomsCapabilities({
      regime: "ACI",
      mode: "border_connect",
      environment: "production",
      ...configured,
    });
    expect(aciProd.amend).toBe(false);
    expect(aciProd.reasons.amend).toMatch(/BORDERCONNECT_ACI_AMEND_ENABLED/);

    const aciFlagged = resolveCustomsCapabilities({
      regime: "ACI",
      mode: "border_connect",
      environment: "production",
      ...configured,
      aciAmendEnabled: true,
    });
    expect(aciFlagged.amend).toBe(true);
    expect(aciFlagged.reasons.amend).toBeUndefined();

    const aciSandbox = resolveCustomsCapabilities({
      regime: "ACI",
      mode: "border_connect",
      environment: "sandbox",
      ...configured,
    });
    expect(aciSandbox.amend).toBe(true);
  });

  it("multiTrailer needs the flag in production, but is on in sandbox regardless", () => {
    const prod = resolveCustomsCapabilities({
      regime: "ACE",
      mode: "border_connect",
      environment: "production",
      ...configured,
    });
    expect(prod.multiTrailer).toBe(false);
    expect(prod.reasons.multiTrailer).toMatch(/BORDERCONNECT_MULTI_TRAILER_ENABLED/);

    const flagged = resolveCustomsCapabilities({
      regime: "ACE",
      mode: "border_connect",
      environment: "production",
      ...configured,
      multiTrailerEnabled: true,
    });
    expect(flagged.multiTrailer).toBe(true);
    expect(flagged.reasons.multiTrailer).toBeUndefined();

    const sandbox = resolveCustomsCapabilities({
      regime: "ACE",
      mode: "border_connect",
      environment: "sandbox",
      ...configured,
    });
    expect(sandbox.multiTrailer).toBe(true);
  });

  it("emptyTrip needs the flag in production, but is on in sandbox regardless", () => {
    const prod = resolveCustomsCapabilities({
      regime: "ACE",
      mode: "border_connect",
      environment: "production",
      ...configured,
    });
    expect(prod.emptyTrip).toBe(false);
    expect(prod.reasons.emptyTrip).toMatch(/BORDERCONNECT_EMPTY_TRIP_ENABLED/);

    const flagged = resolveCustomsCapabilities({
      regime: "ACE",
      mode: "border_connect",
      environment: "production",
      ...configured,
      emptyTripEnabled: true,
    });
    expect(flagged.emptyTrip).toBe(true);
    expect(flagged.reasons.emptyTrip).toBeUndefined();

    const sandbox = resolveCustomsCapabilities({
      regime: "ACE",
      mode: "border_connect",
      environment: "sandbox",
      ...configured,
    });
    expect(sandbox.emptyTrip).toBe(true);
  });

  it("status and inBond are always unavailable once configured — they arrive through the shared inbox / are tracking-only", () => {
    const c = resolveCustomsCapabilities({
      regime: "ACE",
      mode: "border_connect",
      environment: "production",
      ...configured,
    });
    expect(c.status).toBe(false);
    expect(c.inBond).toBe(false);
    expect(c.cancel).toBe(true);
    expect(c.transmit).toBe(true);
  });
});
