import { describe, expect, it } from "vitest";
import {
  hasBlockingIssues,
  validateForTransmit,
  type MovementForValidation,
  type ShipmentForValidation,
} from "./movement-validation";

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

const ready: MovementForValidation = {
  regime: "ACE",
  port: { code: "3801" },
  carrierCode: "PFTR",
  scheduledCrossingAt: "2026-09-08T14:00:00Z",
  driver: {
    licenseExpiry: "2027-01-01",
    fastCardNumber: null,
    citizenship: "CA",
    status: "active",
  },
  truck: {
    registrationExpiry: "2027-01-01",
    insuranceExpiry: "2027-01-01",
    plateNumber: "A",
    status: "active",
  },
  trailer: { registrationExpiry: "2027-01-01", plateNumber: "B", status: "active" },
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

  it("blocks on missing driver, truck, crossing, carrier code and shipments", () => {
    const issues = validateForTransmit(
      { ...ready, driver: null, truck: null, port: null, carrierCode: null, shipments: [] },
      TODAY,
    );
    expect(issues.filter((i) => i.severity === "blocking").map((i) => i.code)).toEqual(
      expect.arrayContaining([
        "crossing_point_missing",
        "carrier_code_missing",
        "truck_missing",
        "driver_missing",
        "shipments_missing",
      ]),
    );
  });

  it("blocks on expired driver license / truck docs; warns on expired FAST", () => {
    const issues = validateForTransmit(
      {
        ...ready,
        driver: {
          ...ready.driver!,
          licenseExpiry: "2026-09-01",
          fastCardNumber: "F",
          fastCardExpiry: "2026-01-01",
        },
        truck: { ...ready.truck!, insuranceExpiry: "2026-09-05" },
      },
      TODAY,
    );
    const byCode = Object.fromEntries(issues.map((i) => [i.code, i.severity]));
    expect(byCode.driver_license_expired).toBe("blocking");
    expect(byCode.truck_insurance_expired).toBe("blocking");
    expect(byCode.driver_fast_expired).toBe("warning");
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

  it("trailer without seal is a warning, not a block", () => {
    const issues = validateForTransmit({ ...ready, seals: [] }, TODAY);
    expect(issues).toEqual([
      expect.objectContaining({ code: "seals_missing", severity: "warning" }),
    ]);
    expect(hasBlockingIssues(issues)).toBe(false);
  });
});
