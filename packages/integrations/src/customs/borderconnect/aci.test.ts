import { describe, expect, it } from "vitest";
import { CustomsTransportError } from "../types";
import { buildManifest, type ManifestSource } from "../manifest";
import { toAciTrip } from "./aci";
import type { OutboundOptions } from "./format";

/** A fully-populated ACI `ManifestSource`. */
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
      seals: ["S9"],
    },
    trailers: [
      {
        unitNumber: "TR-2",
        trailerType: "RT",
        plateNumber: "GH9",
        plateJurisdiction: "ON",
        plates: [],
        seals: ["S10"],
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

describe("toAciTrip — full valid manifest", () => {
  it("produces the exact expected ACI_TRIP object", () => {
    const m = buildManifest(makeSource());
    expect(toAciTrip(m, opts)).toEqual({
      data: "ACI_TRIP",
      sendId: "SID1",
      companyKey: "CK1",
      operation: "CREATE",
      autoSend: true,
      tripNumber: "PFTR00007",
      estimatedArrivalDateTime: "2026-09-08 16:00:00",
      portOfEntry: "0409",
      truck: {
        number: "T-201",
        licensePlate: { number: "AB9", stateProvince: "ON" },
        type: "TR",
        vinNumber: "2FUJA6CV12LJ99999",
        sealNumbers: ["S9"],
      },
      trailers: [
        {
          number: "TR-2",
          type: "RT",
          licensePlate: { number: "GH9", stateProvince: "ON" },
          sealNumbers: ["S10"],
        },
      ],
      drivers: [
        {
          firstName: "H",
          lastName: "D",
          gender: "M",
          dateOfBirth: "1980-01-01",
          citizenshipCountry: "CA",
          travelDocuments: [{ type: "ACW", number: "P999", country: "CA" }],
        },
      ],
      shipments: [
        {
          data: "ACI_SHIPMENT",
          companyKey: "CK1",
          cargoControlNumber: "PFTRCSA00001",
          shipmentType: "CSA",
          portOfEntry: "0409",
          releaseOffice: "0409",
          estimatedArrivalDate: "2026-09-08 16:00:00",
          cityOfLoading: { cityName: "Hamilton", stateProvince: "ON" },
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
          deliveryDestinations: [
            {
              name: "Depot Inc",
              address: {
                addressLine: "3 Warehouse Way",
                city: "Chicago",
                postalCode: "60601",
                stateProvince: "IL",
                country: "US",
              },
            },
          ],
          commodities: [
            {
              description: "Steel Coil",
              quantity: 2,
              packagingUnit: "SKD",
              weight: "1000",
              weightUnit: "KG",
              marksAndNumbers: "LOT-1",
            },
          ],
        },
      ],
    });
  });

  it("carries companyKey on the trip and on every nested shipment", () => {
    const m = buildManifest(makeSource());
    const out = toAciTrip(m, opts) as {
      companyKey: string;
      shipments: Array<{ companyKey: string }>;
    };
    expect(out.companyKey).toBe("CK1");
    expect(out.shipments.every((s) => s.companyKey === "CK1")).toBe(true);
    expect(out.shipments[0]).not.toHaveProperty("operation");
  });
});

describe("toAciTrip — shipmentType resolution table", () => {
  function tripWith(overrides: Partial<ManifestSource["shipments"][number]>) {
    const src = makeSource();
    src.shipments[0] = { ...src.shipments[0]!, cargoType: null, ...overrides };
    return buildManifest(src);
  }

  it("csa -> CSA", () => {
    const m = tripWith({ cargoType: "csa" });
    const out = toAciTrip(m, opts) as { shipments: Array<Record<string, unknown>> };
    expect(out.shipments[0]!.shipmentType).toBe("CSA");
    expect(out.shipments[0]).not.toHaveProperty("consolidatedFreight");
  });

  it("a49 -> A49", () => {
    const m = tripWith({ cargoType: "a49" });
    const out = toAciTrip(m, opts) as { shipments: Array<Record<string, unknown>> };
    expect(out.shipments[0]!.shipmentType).toBe("A49");
  });

  it("e29b -> E29B", () => {
    const m = tripWith({ cargoType: "e29b" });
    const out = toAciTrip(m, opts) as { shipments: Array<Record<string, unknown>> };
    expect(out.shipments[0]!.shipmentType).toBe("E29B");
  });

  it("shipmentType in_bond -> BOND", () => {
    const m = tripWith({ shipmentType: "in_bond", cargoType: null });
    const out = toAciTrip(m, opts) as { shipments: Array<Record<string, unknown>> };
    expect(out.shipments[0]!.shipmentType).toBe("BOND");
  });

  it("consolidated -> PARS with consolidatedFreight: true", () => {
    const m = tripWith({ cargoType: "consolidated" });
    const out = toAciTrip(m, opts) as { shipments: Array<Record<string, unknown>> };
    expect(out.shipments[0]!.shipmentType).toBe("PARS");
    expect(out.shipments[0]!.consolidatedFreight).toBe(true);
  });

  it("regular with a PARS control number -> PARS, no consolidatedFreight", () => {
    const m = tripWith({ cargoType: "regular", controlNumber: "PFTRPARS0001" });
    const out = toAciTrip(m, opts) as { shipments: Array<Record<string, unknown>> };
    expect(out.shipments[0]!.shipmentType).toBe("PARS");
    expect(out.shipments[0]).not.toHaveProperty("consolidatedFreight");
  });

  it("a plain regular shipment with no PARS control number 422s", () => {
    const m = tripWith({ cargoType: "regular", controlNumber: "PFTRPLAIN001" });
    try {
      toAciTrip(m, opts);
      throw new Error("expected toAciTrip to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CustomsTransportError);
      expect((e as CustomsTransportError).message).toBe(
        "BorderConnect: manifest is missing 1 required field(s): " +
          "shipments[0].shipmentType: a plain non-PARS ACI shipment has no confirmed BorderConnect type (open risk)",
      );
    }
  });
});

describe("toAciTrip — ACI trip-flag 422s", () => {
  const flags = ["aciLvs", "aciPostal", "aciFlyingTruck", "aciInTransit", "aciIit"] as const;
  const messageFlag: Record<(typeof flags)[number], string> = {
    aciLvs: "lvs",
    aciPostal: "postal",
    aciFlyingTruck: "flyingTruck",
    aciInTransit: "inTransit",
    aciIit: "iit",
  };

  it.each(flags)("%s 422s as not representable", (flag) => {
    const src = makeSource();
    src.movement = { ...src.movement, [flag]: true };
    const m = buildManifest(src);
    try {
      toAciTrip(m, opts);
      throw new Error("expected toAciTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toBe(
        `BorderConnect: manifest is missing 1 required field(s): trip.aci.${messageFlag[flag]}: not representable in the BorderConnect eManifest API`,
      );
    }
  });

  it("cityOfLoading requires both city and province", () => {
    const src = makeSource();
    src.shipments[0]!.loadingCity = null;
    src.shipments[0]!.loadingProvince = null;
    const m = buildManifest(src);
    try {
      toAciTrip(m, opts);
      throw new Error("expected toAciTrip to throw");
    } catch (e) {
      expect((e as CustomsTransportError).message).toBe(
        "BorderConnect: manifest is missing 2 required field(s): " +
          "shipments[0].loading.city: required (cityOfLoading.cityName); " +
          "shipments[0].loading.province: required (cityOfLoading.stateProvince)",
      );
    }
  });
});
