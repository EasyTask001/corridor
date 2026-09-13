/**
 * Executable supported-filing matrix (docs/operations/supported-filing-matrix.md
 * is generated from this file's intent, not the other way around — this test
 * is the source of truth; the doc explains it to a human).
 *
 * Each case builds a ManifestSource, runs it through buildManifest and the
 * BorderConnect mapper, and asserts either a clean filing or the exact
 * refusal a filer would see. Capability-gated scenarios (amend/cancel/
 * multiTrailer/emptyTrip) are asserted against resolveCustomsCapabilities
 * directly, since those are deployment-configuration decisions, not
 * manifest-shape ones.
 */
import { describe, expect, it } from "vitest";
import { resolveCustomsCapabilities } from "./capabilities";
import { buildManifest, type ManifestSource } from "./manifest";
import { toAceTrip } from "./borderconnect/ace";
import { toAciTrip } from "./borderconnect/aci";
import { CustomsTransportError } from "./types";

const OPTS = { companyKey: "CK1", sendId: "S1", operation: "CREATE" as const, autoSend: false };

function makeSource(overrides: Partial<ManifestSource> = {}): ManifestSource {
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
        dateOfBirth: "1985-03-14",
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
    ],
    truck: {
      unitNumber: "T-101",
      vin: "1FUJA6CV12LJ12345",
      plateNumber: "AB1",
      plateJurisdiction: "ON",
      dotNumber: "1234567",
      truckType: "TR",
      insurancePolicyNumber: null,
      insuranceCompany: null,
      insuranceAmount: null,
      insuranceYear: null,
      plates: [],
      seals: [],
    },
    trailers: [],
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
        loadingCountry: "CA",
        loadingProvince: "ON",
        loadingCity: "Hamilton",
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
        deliveryAddress: null,
        loadedOn: null,
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
    ...overrides,
  };
}

/** An ACI-shaped source: PARS-numbered, regular cargo type, no shipmentType. */
function makeAciSource(overrides: Partial<ManifestSource> = {}): ManifestSource {
  const ace = makeSource();
  return {
    ...ace,
    movement: { ...ace.movement, regime: "ACI", tripNumber: "1234123456" },
    truck: { ...ace.truck!, unitNumber: "T-201" },
    shipments: [
      {
        ...ace.shipments[0]!,
        controlNumber: "1234PARS0001",
        shipmentType: null,
        cargoType: "regular",
      },
    ],
    ...overrides,
  };
}

const trailer = (movementTrailerId: string, unitNumber: string) => ({
  movementTrailerId,
  unitNumber,
  trailerType: "TF",
  plateNumber: "TR1",
  plateJurisdiction: "ON",
  plates: [],
  seals: [],
});

/** Files (or attempts to) and reports what happened, uniformly across the
 * two mappers and buildManifest's own precondition throws. */
function attemptFiling(src: ManifestSource): { ok: true } | { ok: false; message: string } {
  try {
    const manifest = buildManifest(src);
    if (manifest.regime === "ACE") toAceTrip(manifest, OPTS);
    else toAciTrip(manifest, OPTS);
    return { ok: true };
  } catch (e) {
    if (e instanceof CustomsTransportError || e instanceof Error) {
      return { ok: false, message: e.message };
    }
    throw e;
  }
}

describe("supported filing matrix — ACE", () => {
  it("standard PAPS shipment, bobtail: files clean", () => {
    expect(attemptFiling(makeSource())).toEqual({ ok: true });
  });

  it("single trailer: files clean with no explicit loadedOn required", () => {
    expect(attemptFiling(makeSource({ trailers: [trailer("mt-1", "TR-501")] }))).toEqual({
      ok: true,
    });
  });

  it("two trailers with an explicit choice: files clean", () => {
    const src = makeSource({
      trailers: [trailer("mt-1", "TR-501"), trailer("mt-2", "TR-502")],
    });
    src.shipments[0]!.loadedOn = { type: "TRAILER", movementTrailerId: "mt-1" };
    expect(attemptFiling(src)).toEqual({ ok: true });
  });

  it("two trailers with nothing chosen: refused (ambiguous placement)", () => {
    const result = attemptFiling(
      makeSource({ trailers: [trailer("mt-1", "TR-501"), trailer("mt-2", "TR-502")] }),
    );
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(/more than one trailer/);
  });

  it("empty trip: buildManifest accepts it (no wire indicator exists in the manual)", () => {
    const src = makeSource({
      movement: { ...makeSource().movement, isEmpty: true },
      shipments: [],
    });
    expect(attemptFiling(src)).toEqual({ ok: true });
  });

  it("hazmat commodity: refused — no emergency-contact capture yet", () => {
    const src = makeSource();
    src.shipments[0]!.commodities[0]!.hazmat = [{ unCode: "UN1203", description: "Gasoline" }];
    const result = attemptFiling(src);
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(/emergency contact/);
  });

  it("in-bond shipment: refused — irsNumber/fda not captured yet", () => {
    const src = makeSource();
    src.shipments[0]!.shipmentType = "in_bond";
    const result = attemptFiling(src);
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(/irsNumber\/fda/);
  });

  it("amend and cancel are always available once BorderConnect is configured", () => {
    const c = resolveCustomsCapabilities({
      regime: "ACE",
      mode: "border_connect",
      environment: "production",
      apiUrlSuffix: "service-provider",
      apiKey: "secret",
      companyKey: "CK1",
    });
    expect(c.amend).toBe(true);
    expect(c.cancel).toBe(true);
  });
});

describe("supported filing matrix — ACI", () => {
  it("standard PARS shipment, bobtail: files clean", () => {
    expect(attemptFiling(makeAciSource())).toEqual({ ok: true });
  });

  it("a plain non-PARS shipment: refused — no confirmed BorderConnect type", () => {
    const src = makeAciSource();
    src.shipments[0]!.controlNumber = "1234REGULR1"; // no "PARS" substring
    const result = attemptFiling(src);
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(/no confirmed BorderConnect type/);
  });

  (["aciLvs", "aciPostal", "aciFlyingTruck", "aciInTransit", "aciIit"] as const).forEach((flag) => {
    it(`${flag}: refused — not representable in the BorderConnect API`, () => {
      const src = makeAciSource({ movement: { ...makeAciSource().movement, [flag]: true } });
      const result = attemptFiling(src);
      expect(result.ok).toBe(false);
      expect((result as { message: string }).message).toMatch(
        /not representable in the BorderConnect/,
      );
    });
  });

  it("amendment is gated in production until BORDERCONNECT_ACI_AMEND_ENABLED is set", () => {
    const gated = resolveCustomsCapabilities({
      regime: "ACI",
      mode: "border_connect",
      environment: "production",
      apiUrlSuffix: "service-provider",
      apiKey: "secret",
      companyKey: "CK1",
    });
    expect(gated.amend).toBe(false);

    const flagged = resolveCustomsCapabilities({
      regime: "ACI",
      mode: "border_connect",
      environment: "production",
      apiUrlSuffix: "service-provider",
      apiKey: "secret",
      companyKey: "CK1",
      aciAmendEnabled: true,
    });
    expect(flagged.amend).toBe(true);
  });
});

describe("supported filing matrix — production gates (BorderConnect, configured)", () => {
  const base = {
    mode: "border_connect" as const,
    environment: "production" as const,
    apiUrlSuffix: "service-provider",
    apiKey: "secret",
    companyKey: "CK1",
  };

  it("multi-trailer manifests are blocked until BORDERCONNECT_MULTI_TRAILER_ENABLED is set", () => {
    expect(resolveCustomsCapabilities({ regime: "ACE", ...base }).multiTrailer).toBe(false);
    expect(
      resolveCustomsCapabilities({ regime: "ACE", ...base, multiTrailerEnabled: true })
        .multiTrailer,
    ).toBe(true);
  });

  it("empty-trip manifests are blocked until BORDERCONNECT_EMPTY_TRIP_ENABLED is set", () => {
    expect(resolveCustomsCapabilities({ regime: "ACE", ...base }).emptyTrip).toBe(false);
    expect(
      resolveCustomsCapabilities({ regime: "ACE", ...base, emptyTripEnabled: true }).emptyTrip,
    ).toBe(true);
  });

  it("status and QP In-Bond remain unavailable regardless of flags — inbox-driven / tracking-only", () => {
    const c = resolveCustomsCapabilities({ regime: "ACE", ...base });
    expect(c.status).toBe(false);
    expect(c.inBond).toBe(false);
  });
});
