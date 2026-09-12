import { describe, expect, it } from "vitest";
import {
  hasBlockingIssues,
  validateForTransmit,
  type CrewForValidation,
  type MovementForValidation,
  type ShipmentForValidation,
} from "./movement-validation";
import { expectedPartnerCountry } from "./registry";

const TODAY = "2026-09-06";

const shipment: ShipmentForValidation = {
  controlNumber: "PFTRPAPS0001",
  shipmentType: "regular_bill",
  cargoType: null,
  shipper: { name: "Maple Ridge Steel", country: "CA" },
  consignee: { name: "Great Lakes Fabrication", country: "US" },
  entryNumber: null,
  inBondEntryType: null,
  inBondDestinationPortId: null,
  destinationPortId: null,
  commodities: [
    {
      commodityDescription: "Steel coils",
      hsCode: "7208.10",
      weightKg: 20000,
      quantity: 10,
      quantityUnit: "Coil",
      valueAmount: 50000,
      valueCurrency: "USD",
      countryOfOrigin: "CA",
    },
  ],
};

const pic: CrewForValidation = {
  role: "person_in_charge",
  personType: "driver",
  displayName: "Gurpreet Singh",
  licenseExpiry: "2027-01-01",
  status: "active",
  citizenship: "CA",
  usAddress: {},
  documents: [],
};

const ready: MovementForValidation = {
  regime: "ACE",
  port: { code: "3801" },
  carrierCode: "PFTR",
  scheduledCrossingAt: "2026-09-08T14:00:00Z",
  crew: [pic],
  truck: {
    registrationExpiry: "2027-01-01",
    insuranceExpiry: "2027-01-01",
    plateNumber: "A",
    status: "active",
  },
  isEmpty: false,
  aciInTransit: false,
  trailers: [
    {
      unitNumber: "TR-501",
      registrationExpiry: "2027-01-01",
      plateNumber: "B",
      status: "active",
      sealCount: 1,
    },
  ],
  shipments: [shipment],
  seals: [{ sealNumber: "S1" }],
};

const codes = (m: MovementForValidation) => validateForTransmit(m, TODAY).map((i) => i.code);

describe("validateForTransmit", () => {
  it("passes a complete movement", () => {
    const issues = validateForTransmit(ready, TODAY);
    expect(issues).toEqual([]);
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  it("blocks on missing crew, truck, crossing, carrier code and shipments", () => {
    const issues = validateForTransmit(
      { ...ready, crew: [], truck: null, port: null, carrierCode: null, shipments: [] },
      TODAY,
    );
    expect(issues.filter((i) => i.severity === "blocking").map((i) => i.code)).toEqual(
      expect.arrayContaining([
        "crossing_point_missing",
        "carrier_code_missing",
        "truck_missing",
        "crew_pic_missing",
        "shipments_missing",
      ]),
    );
  });

  it("blocks when the person in charge is a passenger", () => {
    expect(
      codes({ ...ready, crew: [{ ...pic, personType: "passenger", documents: [] }] }),
    ).toContain("crew_pic_not_driver");
  });

  it("blocks a passenger with no travel document", () => {
    const passenger: CrewForValidation = {
      ...pic,
      role: "passenger",
      personType: "passenger",
      displayName: "Ada Rider",
      licenseExpiry: null,
    };
    expect(codes({ ...ready, crew: [pic, passenger] })).toContain(
      "crew_1_passenger_document_missing",
    );
    expect(
      codes({
        ...ready,
        crew: [pic, { ...passenger, documents: [{ documentType: "passport", expiresOn: null }] }],
      }),
    ).not.toContain("crew_1_passenger_document_missing");
  });

  it("blocks on expired license / truck docs; warns on expired FAST and NEXUS", () => {
    const issues = validateForTransmit(
      {
        ...ready,
        crew: [
          {
            ...pic,
            licenseExpiry: "2026-09-01",
            documents: [
              { documentType: "fast", expiresOn: "2026-01-01" },
              { documentType: "nexus", expiresOn: "2026-01-01" },
            ],
          },
        ],
        truck: { ...ready.truck!, insuranceExpiry: "2026-09-05" },
      },
      TODAY,
    );
    const byCode = Object.fromEntries(issues.map((i) => [i.code, i.severity]));
    expect(byCode.crew_0_license_expired).toBe("blocking");
    expect(byCode.truck_insurance_expired).toBe("blocking");
    expect(byCode.crew_0_fast_expired).toBe("warning");
    expect(byCode.crew_0_nexus_expired).toBe("warning");
  });

  it("warns when an ACE passenger has no US address and the consignee is not US", () => {
    const passenger: CrewForValidation = {
      ...pic,
      role: "passenger",
      personType: "passenger",
      displayName: "Ada Rider",
      licenseExpiry: null,
      documents: [{ documentType: "passport", expiresOn: "2030-01-01" }],
    };
    const foreignConsignee = {
      ...ready,
      crew: [pic, passenger],
      shipments: [{ ...shipment, consignee: { name: "Maple Ridge", country: "CA" } }],
    };
    expect(codes(foreignConsignee)).toContain("crew_1_us_address_missing");
    expect(
      codes({
        ...foreignConsignee,
        crew: [pic, { ...passenger, usAddress: { city: "Detroit", country: "US" } }],
      }),
    ).not.toContain("crew_1_us_address_missing");
  });

  it("requires a shipper and a consignee on every shipment", () => {
    expect(
      codes({ ...ready, shipments: [{ ...shipment, shipper: null, consignee: null }] }),
    ).toEqual(expect.arrayContaining(["shipment_0_shipper", "shipment_0_consignee"]));
  });

  it("requires weight, quantity and a quantity unit on every commodity line", () => {
    const issues = validateForTransmit(
      {
        ...ready,
        shipments: [
          {
            ...shipment,
            commodities: [{ commodityDescription: "x", hsCode: "7208.10" }],
          },
        ],
      },
      TODAY,
    );
    expect(issues.filter((i) => i.severity === "blocking").map((i) => i.code)).toEqual([
      "shipment_0_commodity_0_weight",
      "shipment_0_commodity_0_quantity",
      "shipment_0_commodity_0_quantity_unit",
    ]);
    expect(issues.every((i) => i.step !== "commodity" || i.code.includes("commodity"))).toBe(true);
  });

  it("blocks an empty shipment on the commodity step", () => {
    const issues = validateForTransmit(
      { ...ready, shipments: [{ ...shipment, commodities: [] }] },
      TODAY,
    );
    expect(issues).toEqual([
      expect.objectContaining({
        code: "shipment_0_commodities",
        severity: "blocking",
        step: "commodity",
      }),
    ]);
  });

  it("blocks an in-bond shipment without an entry type and destination", () => {
    expect(codes({ ...ready, shipments: [{ ...shipment, shipmentType: "in_bond" }] })).toContain(
      "shipment_0_in_bond",
    );
    expect(
      codes({
        ...ready,
        shipments: [
          {
            ...shipment,
            shipmentType: "in_bond",
            inBondEntryType: "IT",
            inBondDestinationPortId: "11111111-1111-1111-1111-111111111111",
          },
        ],
      }),
    ).not.toContain("shipment_0_in_bond");
  });

  it("blocks an ACI consolidated shipment with fewer than two commodity lines", () => {
    const aci: MovementForValidation = {
      ...ready,
      regime: "ACI",
      shipments: [
        {
          ...shipment,
          shipmentType: null,
          cargoType: "consolidated",
          shipper: { name: "Great Lakes Fabrication", country: "US" },
          consignee: { name: "Maple Ridge Steel", country: "CA" },
        },
      ],
    };
    expect(codes(aci)).toContain("shipment_0_consolidated");
    expect(
      codes({
        ...aci,
        shipments: [
          {
            ...aci.shipments[0]!,
            commodities: [shipment.commodities[0]!, shipment.commodities[0]!],
          },
        ],
      }),
    ).not.toContain("shipment_0_consolidated");
  });

  it("warns when the ACE shipper is not Canadian / the consignee not American", () => {
    const issues = validateForTransmit(
      {
        ...ready,
        shipments: [
          {
            ...shipment,
            shipper: { name: "X", country: "US" },
            consignee: { name: "Y", country: "CA" },
          },
        ],
      },
      TODAY,
    );
    expect(issues.map((i) => `${i.code}:${i.severity}`)).toEqual([
      "shipment_0_shipper_country:warning",
      "shipment_0_consignee_country:warning",
    ]);
  });

  it("reverses the country expectation for ACI", () => {
    const issues = validateForTransmit(
      {
        ...ready,
        regime: "ACI",
        shipments: [
          {
            ...shipment,
            shipmentType: null,
            cargoType: "regular",
            shipper: { name: "X", country: "US" },
            consignee: { name: "Y", country: "CA" },
          },
        ],
      },
      TODAY,
    );
    expect(issues.map((i) => i.code)).not.toEqual(
      expect.arrayContaining(["shipment_0_shipper_country", "shipment_0_consignee_country"]),
    );
  });

  it("derives the expected shipper/consignee countries from expectedPartnerCountry", () => {
    const aciWarnings = validateForTransmit(
      {
        ...ready,
        regime: "ACI",
        shipments: [
          {
            ...shipment,
            shipmentType: null,
            cargoType: "regular",
            shipper: { ...shipment.shipper!, country: "CA" },
            consignee: { ...shipment.consignee!, country: "US" },
          },
        ],
      },
      TODAY,
    );
    expect(aciWarnings.map((i) => i.code)).toEqual(
      expect.arrayContaining(["shipment_0_shipper_country", "shipment_0_consignee_country"]),
    );
    expect(aciWarnings.find((i) => i.code === "shipment_0_shipper_country")?.message).toContain(
      `not ${expectedPartnerCountry("ACI", "shipper")}`,
    );
  });

  it("trailer without seal is a warning, not a block", () => {
    const issues = validateForTransmit(
      { ...ready, trailers: [{ ...ready.trailers[0]!, sealCount: 0 }], seals: [] },
      TODAY,
    );
    expect(issues).toEqual([
      expect.objectContaining({ code: "trailer_0_seals_missing", severity: "warning" }),
    ]);
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  it("checks every trailer on a double: an expired second trailer blocks", () => {
    const issues = validateForTransmit(
      {
        ...ready,
        trailers: [
          ready.trailers[0]!,
          { ...ready.trailers[0]!, unitNumber: "TR-502", registrationExpiry: "2020-01-01" },
        ],
      },
      TODAY,
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "trailer_1_registration_expired", severity: "blocking" }),
    );
  });

  it("an empty trip needs no shipment or trailer; a non-empty bobtail with nothing needs one", () => {
    const empty = validateForTransmit(
      { ...ready, isEmpty: true, trailers: [], shipments: [], seals: [] },
      TODAY,
    );
    expect(hasBlockingIssues(empty)).toBe(false);
    expect(empty.map((i) => i.code)).toEqual(["trailer_missing"]);

    const bare = codes({ ...ready, trailers: [], shipments: [], seals: [] });
    expect(bare).toContain("empty_or_missing");
    expect(bare).not.toContain("shipments_missing");
  });

  it("an ACI in-transit trip needs a destination office on every shipment", () => {
    const aci: MovementForValidation = { ...ready, regime: "ACI", aciInTransit: true };
    expect(codes(aci)).toContain("shipment_0_in_transit_destination");
    expect(
      codes({ ...aci, shipments: [{ ...shipment, destinationPortId: "port-1" }] }),
    ).not.toContain("shipment_0_in_transit_destination");
    expect(codes({ ...ready, aciInTransit: true })).not.toContain(
      "shipment_0_in_transit_destination",
    );
  });

  it("an empty trip that still carries shipments is blocked", () => {
    expect(codes({ ...ready, isEmpty: true })).toContain("empty_with_shipments");
  });
});
