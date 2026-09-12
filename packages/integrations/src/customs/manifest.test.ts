import { describe, expect, it } from "vitest";
import { buildManifest, type ManifestSource } from "./manifest";

/** Minimal valid ManifestSource — every field required by buildManifest's six preconditions. */
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
      vin: null,
      plateNumber: "AB1",
      plateJurisdiction: "ON",
      dotNumber: "1234567",
      truckType: "TR",
      insurancePolicyNumber: "POL-1",
      insuranceCompany: "Northbridge",
      insuranceAmount: 2000000,
      insuranceYear: 2026,
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
        shipperName: "A",
        shipperAddress: { line1: "1 Mill Rd", city: "Hamilton", region: "ON", country: "CA" },
        consigneeName: "B",
        consigneeAddress: {
          line1: "2 Depot Ave",
          city: "Detroit",
          region: "MI",
          postalCode: "48201",
          country: "US",
        },
        deliveryAddress: {
          line1: "3 Warehouse Way",
          city: "Chicago",
          region: "IL",
          postalCode: "60601",
          country: "US",
        },
        commodities: [
          {
            commodityDescription: "Steel",
            hsCode: "7208.10",
            quantity: 2,
            quantityUnit: "Coil",
            weightKg: 100,
            weightUnit: "KG",
            packagingType: "Skid",
            marksAndNumbers: null,
            countryOfOrigin: "CA",
            valueAmount: 10,
            valueCurrency: "USD",
            hazmat: [{ unCode: "UN1203", description: "Gasoline" }],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("buildManifest — fields BorderConnect needs", () => {
  it("carries carrier scac, canadian code and timezone", () => {
    const m = buildManifest(makeSource());
    expect(m.carrier.scac).toBe("PFTR");
    expect(m.carrier.canadianCarrierCode).toBe("1234567");
    expect(m.carrier.timezone).toBe("America/Toronto");
  });

  it("carries crew dateOfBirth", () => {
    const m = buildManifest(makeSource());
    expect(m.crew[0]?.dateOfBirth).toBe("1985-03-14");
  });

  it("carries truckType", () => {
    const m = buildManifest(makeSource());
    expect(m.conveyance.truckType).toBe("TR");
  });

  it("carries shipment loading place and structured party postal address", () => {
    const m = buildManifest(makeSource());
    const s = m.shipments[0]!;
    expect(s.loading).toEqual({ country: "CA", province: "ON", city: "Hamilton" });
    expect(s.shipper?.postal).toEqual({
      line1: "1 Mill Rd",
      line2: null,
      city: "Hamilton",
      region: "ON",
      postalCode: null,
      country: "CA",
    });
    expect(s.consignee?.postal).toEqual({
      line1: "2 Depot Ave",
      line2: null,
      city: "Detroit",
      region: "MI",
      postalCode: "48201",
      country: "US",
    });
    expect(s.delivery).toEqual({
      line1: "3 Warehouse Way",
      line2: null,
      city: "Chicago",
      region: "IL",
      postalCode: "60601",
      country: "US",
    });
  });

  it("delivery is null when no delivery address is on file", () => {
    const src = makeSource();
    src.shipments[0]!.deliveryAddress = null;
    const m = buildManifest(src);
    expect(m.shipments[0]?.delivery).toBeNull();
  });

  it("carries commodity packagingType and weightUnit", () => {
    const m = buildManifest(makeSource());
    const c = m.shipments[0]!.commodities[0]!;
    expect(c.packagingType).toBe("Skid");
    expect(c.weightUnit).toBe("KG");
  });

  it("still requires a person in charge", () => {
    expect(() => buildManifest({ ...makeSource(), crew: [] })).toThrow(/person in charge/);
  });

  it("still requires a truck", () => {
    expect(() => buildManifest({ ...makeSource(), truck: null })).toThrow(/truck/);
  });

  it("still requires a port of entry", () => {
    const src = makeSource();
    expect(() =>
      buildManifest({ ...src, movement: { ...src.movement, port: null } }),
    ).toThrow(/port/);
  });

  it("still requires a carrier code", () => {
    const src = makeSource();
    expect(() =>
      buildManifest({ ...src, movement: { ...src.movement, carrierCode: null } }),
    ).toThrow(/carrier code/);
  });

  it("still requires an ETA", () => {
    const src = makeSource();
    expect(() =>
      buildManifest({ ...src, movement: { ...src.movement, scheduledCrossingAt: null } }),
    ).toThrow(/ETA/);
  });

  it("still requires at least one shipment unless the trip is empty, and rejects shipments on an empty trip", () => {
    expect(() => buildManifest({ ...makeSource(), shipments: [] })).toThrow(/shipment/);
    const src = makeSource();
    expect(() =>
      buildManifest({ ...src, movement: { ...src.movement, isEmpty: true } }),
    ).toThrow(/empty trip/);
  });
});
