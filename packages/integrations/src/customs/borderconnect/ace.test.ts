import { describe, expect, it } from "vitest";
import { CustomsTransportError } from "../types";
import { buildManifest, type ManifestSource } from "../manifest";
import { toAceTrip } from "./ace";
import type { OutboundOptions } from "./format";

/** A fully-populated ACE `ManifestSource` — every optional BorderConnect field set. */
function makeSource(): ManifestSource {
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
      iitIndicator: "iit_carrier_bond",
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
            documentType: "fast",
            documentNumber: "42700000000001",
            issuingCountry: "CA",
            issuingState: null,
            expiresOn: "2030-01-01",
          },
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
        firstName: "P",
        lastName: "Q",
        gender: "F",
        licenseNumber: null,
        licenseJurisdiction: null,
        citizenship: "US",
        dateOfBirth: "1990-05-05",
        hazmatEndorsement: false,
        documents: [
          {
            documentType: "nexus",
            documentNumber: "N123",
            issuingCountry: "US",
            issuingState: null,
            expiresOn: "2028-01-01",
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
      plates: [
        { plateNumber: "CD2", jurisdiction: "QC" },
        { plateNumber: "EF3", jurisdiction: "NY" },
      ],
      seals: ["S1"],
    },
    trailers: [
      {
        unitNumber: "TR-1",
        trailerType: "TF",
        plateNumber: "GH4",
        plateJurisdiction: "ON",
        plates: [],
        seals: ["S2"],
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
        deliveryAddress: {
          line1: "3 Warehouse Way",
          city: "Chicago",
          region: "IL",
          postalCode: "60601",
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
            marksAndNumbers: "LOT-1",
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

const opts: OutboundOptions = {
  companyKey: "CK1",
  sendId: "SID1",
  operation: "CREATE",
  autoSend: true,
};

describe("toAceTrip — full valid manifest", () => {
  it("produces the exact expected ACE_TRIP object", () => {
    const m = buildManifest(makeSource());
    expect(toAceTrip(m, opts)).toEqual({
      data: "ACE_TRIP",
      sendId: "SID1",
      companyKey: "CK1",
      operation: "CREATE",
      autoSend: true,
      tripNumber: "PFTR00001",
      estimatedArrivalDateTime: "2026-09-08 10:30:00",
      usPortOfArrival: "3801",
      instrumentsOfInternationalTrafficBond: { type: "CARRIER" },
      truck: {
        number: "T-101",
        type: "TR",
        vinNumber: "1FUJA6CV12LJ12345",
        licensePlates: [
          { number: "AB1", stateProvince: "ON" },
          { number: "CD2", stateProvince: "QC" },
        ],
        sealNumbers: ["S1"],
        dotNumber: "1234567",
      },
      trailers: [
        {
          number: "TR-1",
          type: "TF",
          licensePlates: [{ number: "GH4", stateProvince: "ON" }],
          sealNumbers: ["S2"],
        },
      ],
      drivers: [
        {
          firstName: "G",
          lastName: "S",
          gender: "M",
          dateOfBirth: "1985-03-14",
          citizenshipCountry: "CA",
          fastCardNumber: "42700000000001",
          travelDocuments: [{ type: "ACW", number: "P123", country: "CA" }],
        },
      ],
      passengers: [
        {
          firstName: "P",
          lastName: "Q",
          gender: "F",
          dateOfBirth: "1990-05-05",
          citizenshipCountry: "US",
          travelDocuments: [{ type: "AEW", number: "N123", country: "US" }],
        },
      ],
      shipments: [
        {
          data: "ACE_SHIPMENT",
          companyKey: "CK1",
          shipmentControlNumber: "PFTRPAPS0001",
          type: "PAPS",
          provinceOfLoading: "ON",
          shipper: {
            name: "Acme Steel",
            address: {
              addressLine: "1 Mill Rd",
              city: "Hamilton",
              postalCode: "L8L1A1",
              stateProvince: "ON",
              country: "CA",
            },
          },
          consignee: {
            name: "Depot Inc",
            address: {
              addressLine: "2 Depot Ave",
              city: "Detroit",
              postalCode: "48201",
              stateProvince: "MI",
              country: "US",
            },
          },
          commodities: [
            {
              description: "Steel Coil",
              quantity: 2,
              packagingUnit: "SKD",
              weight: 1000,
              weightUnit: "KG",
              marksAndNumbers: ["LOT-1"],
              harmonizedCode: "720810",
              value: "5000",
              countryOfOrigin: "CA",
            },
          ],
        },
      ],
    });
  });

  it("puts instrumentsOfInternationalTrafficBond at the trip level, never on a nested shipment", () => {
    const m = buildManifest(makeSource());
    const out = toAceTrip(m, opts) as {
      instrumentsOfInternationalTrafficBond?: { type: string };
      shipments: Array<Record<string, unknown>>;
    };
    expect(out.instrumentsOfInternationalTrafficBond).toEqual({ type: "CARRIER" });
    expect(out.shipments[0]).not.toHaveProperty("instrumentsOfInternationalTrafficBond");
  });

  it("omits instrumentsOfInternationalTrafficBond entirely when iitIndicator is none", () => {
    const src = makeSource();
    src.movement.iitIndicator = "none";
    const m = buildManifest(src);
    const out = toAceTrip(m, opts);
    expect(out).not.toHaveProperty("instrumentsOfInternationalTrafficBond");
  });

  it("carries companyKey on the trip and on every nested shipment", () => {
    const m = buildManifest(makeSource());
    const out = toAceTrip(m, opts) as {
      companyKey: string;
      shipments: Array<{ companyKey: string }>;
    };
    expect(out.companyKey).toBe("CK1");
    expect(out.shipments.every((s) => s.companyKey === "CK1")).toBe(true);
  });

  it("passes operation/autoSend straight through, and nested shipments never carry their own operation", () => {
    const m = buildManifest(makeSource());
    const out = toAceTrip(m, { ...opts, operation: "UPDATE", autoSend: false }) as {
      operation: string;
      autoSend: boolean;
      shipments: Array<Record<string, unknown>>;
    };
    expect(out.operation).toBe("UPDATE");
    expect(out.autoSend).toBe(false);
    expect(out.shipments[0]).not.toHaveProperty("operation");
  });

  it("uses tripNumberOverride instead of deriving one", () => {
    const m = buildManifest(makeSource());
    const out = toAceTrip(m, { ...opts, tripNumberOverride: "PFTRZZZZZ" }) as {
      tripNumber: string;
    };
    expect(out.tripNumber).toBe("PFTRZZZZZ");
  });

  it("matches the packaging-unit name case-insensitively", () => {
    const src = makeSource();
    src.shipments[0]!.commodities[0]!.packagingType = "sKiD"; // real value is "Skid" in code-lists.ts
    const m = buildManifest(src);
    const out = toAceTrip(m, opts) as {
      shipments: Array<{ commodities: Array<{ packagingUnit: string }> }>;
    };
    expect(out.shipments[0]!.commodities[0]!.packagingUnit).toBe("SKD");
  });

  it("omits gender X instead of sending it", () => {
    const src = makeSource();
    src.crew[0]!.gender = "X";
    const m = buildManifest(src);
    // an "X" driver is otherwise valid — no 422 — but gender must be omitted, not sent as "X".
    const out = toAceTrip(m, opts) as { drivers: Array<Record<string, unknown>> };
    expect(out.drivers[0]).not.toHaveProperty("gender");
  });
});

describe("toAceTrip — 422 validation", () => {
  it("names every missing field at once: removing vin AND provinceOfLoading together names both", () => {
    const src = makeSource();
    src.truck!.vin = null;
    src.shipments[0]!.loadingProvince = null;
    const m = buildManifest(src);
    expect(() => toAceTrip(m, opts)).toThrow(CustomsTransportError);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CustomsTransportError);
      expect((e as CustomsTransportError).statusCode).toBe(422);
      expect((e as CustomsTransportError).message).toBe(
        "BorderConnect: manifest is missing 2 required field(s): " +
          "conveyance.vin: required for ACE; " +
          "shipments[0].loading.province: required (provinceOfLoading)",
      );
    }
  });

  it("requires at least one driver (person_in_charge/crew_member)", () => {
    // buildManifest itself refuses to build a payload with no person in
    // charge, so exercise validate.ts's own defence directly against a
    // ManifestPayload with no driver-role crew at all (e.g. a hand-built
    // payload, or one from a future source that doesn't share buildManifest's
    // precondition).
    const m = buildManifest(makeSource());
    m.crew = m.crew.filter((c) => c.role === "passenger");
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toBe(
        "BorderConnect: manifest is missing 1 required field(s): crew: ACE requires at least one driver",
      );
    }
  });

  it("a passenger missing gender/dateOfBirth/citizenship/documents names all four", () => {
    const src = makeSource();
    src.crew[1] = {
      role: "passenger",
      firstName: "P",
      lastName: "Q",
      gender: null,
      licenseNumber: null,
      licenseJurisdiction: null,
      citizenship: null,
      dateOfBirth: null,
      hazmatEndorsement: false,
      documents: [],
    };
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toContain(
        "passengers[0]: missing gender, dateOfBirth, citizenshipCountry, travelDocuments",
      );
    }
  });

  it("a driver missing dateOfBirth 422s naming the field", () => {
    // Without this rule `buildDriver` shipped `dateOfBirth: null` on the wire —
    // a silently incomplete ACE filing, which is exactly what this adapter is
    // built never to do.
    const src = makeSource();
    src.crew[0]!.dateOfBirth = null;
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).statusCode).toBe(422);
      expect((e as CustomsTransportError).message).toContain("drivers[0]: missing dateOfBirth");
    }
  });

  it("a driver missing dateOfBirth and citizenship names both, in the same single throw", () => {
    const src = makeSource();
    src.crew[0]!.dateOfBirth = null;
    src.crew[0]!.citizenship = null;
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toContain(
        "drivers[0]: missing dateOfBirth, citizenshipCountry",
      );
    }
  });

  it("a passenger carrying only an unmapped document type 422s rather than shipping travelDocuments: []", () => {
    // `permanent_resident_card` is deliberately absent from
    // DRIVER_DOCUMENT_TYPE_MAP (two BorderConnect PR-card codes, nothing to
    // disambiguate), so `travelDocuments()` drops it. Counting raw
    // `documents.length` here passed this passenger and sent an empty array.
    const src = makeSource();
    src.crew[1]!.documents = [
      {
        documentType: "permanent_resident_card",
        documentNumber: "PR123",
        issuingCountry: "US",
        issuingState: null,
        expiresOn: "2030-01-01",
      },
    ];
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).statusCode).toBe(422);
      expect((e as CustomsTransportError).message).toContain(
        "passengers[0]: missing travelDocuments",
      );
    }
  });

  it("a passenger with gender X is also missing gender (BorderConnect only accepts M/F)", () => {
    const src = makeSource();
    src.crew[1]!.gender = "X";
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toContain("passengers[0]: missing gender");
    }
  });

  it("hazmat lines 422", () => {
    const src = makeSource();
    src.shipments[0]!.commodities[0]!.hazmat = [{ unCode: "UN1203", description: "Gasoline" }];
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toBe(
        "BorderConnect: manifest is missing 1 required field(s): " +
          "shipments[0].commodities[0].hazmat: BorderConnect requires an emergency contact Corridor does not capture yet",
      );
    }
  });

  it("an in_bond shipmentType 422s (v1 does not capture irsNumber/fda)", () => {
    const src = makeSource();
    src.shipments[0]!.shipmentType = "in_bond";
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toBe(
        "BorderConnect: manifest is missing 1 required field(s): " +
          "shipments[0].inBond: irsNumber/fda not captured yet",
      );
    }
  });

  it("a malformed shipmentControlNumber 422s", () => {
    const src = makeSource();
    src.shipments[0]!.controlNumber = "bad!";
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toBe(
        "BorderConnect: manifest is missing 1 required field(s): " +
          "shipments[0].controlNumber: must be 4 letters followed by 4-12 alphanumerics",
      );
    }
  });

  it("an unconfirmed ACE shipment type 422s", () => {
    const src = makeSource();
    src.shipments[0]!.shipmentType = "section_321";
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toBe(
        "BorderConnect: manifest is missing 1 required field(s): " +
          "shipments[0].shipmentType: no BorderConnect shipment type for section_321",
      );
    }
  });

  it("an unmapped trailer type 422s", () => {
    const src = makeSource();
    src.trailers[0]!.trailerType = "TQ";
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toBe(
        "BorderConnect: manifest is missing 1 required field(s): " +
          "equipment[0].type: no BorderConnect trailer type for TQ",
      );
    }
  });

  it("an unmapped packaging name 422s", () => {
    const src = makeSource();
    src.shipments[0]!.commodities[0]!.packagingType = "Unicorn Box";
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toBe(
        "BorderConnect: manifest is missing 1 required field(s): " +
          "shipments[0].commodities[0].packagingUnit: no BorderConnect packaging unit for Unicorn Box",
      );
    }
  });

  it("null quantity and null weight both 422", () => {
    const src = makeSource();
    src.shipments[0]!.commodities[0]!.quantity = null;
    src.shipments[0]!.commodities[0]!.weightKg = null;
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toBe(
        "BorderConnect: manifest is missing 2 required field(s): " +
          "shipments[0].commodities[0].quantity: required; " +
          "shipments[0].commodities[0].weight: required",
      );
    }
  });

  it("a shipper missing every mandatory field names all four", () => {
    const src = makeSource();
    src.shipments[0]!.shipperName = null;
    src.shipments[0]!.shipperAddress = {};
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toBe(
        "BorderConnect: manifest is missing 4 required field(s): " +
          "shipments[0].shipper.name: required; " +
          "shipments[0].shipper.addressLine: required; " +
          "shipments[0].shipper.city: required; " +
          "shipments[0].shipper.postalCode: required",
      );
    }
  });

  it("an invalid trip number (and no valid derivation) 422s", () => {
    const src = makeSource();
    src.movement.tripNumber = null;
    src.movement.carrierCode = "P1";
    const m = buildManifest(src);
    try {
      toAceTrip(m, opts);
      throw new Error("expected toAceTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toContain(
        "trip.tripNumber: must start with the carrier code and be 8–25 alphanumerics",
      );
    }
  });
});
