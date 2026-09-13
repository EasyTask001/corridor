import { describe, expect, it } from "vitest";
import type { ManifestPayload } from "../types";
import { validateForBorderConnect } from "./validate";

/** A minimal, otherwise-valid ACE manifest — every field validateForBorderConnect
 * would not otherwise complain about, so each test isolates one problem. */
function manifest(overrides: Partial<ManifestPayload> = {}): ManifestPayload {
  return {
    regime: "ACE",
    carrier: {
      code: "ABCD",
      filerCode: null,
      usDotNumber: null,
      name: "Carrier",
      scac: "ABCD",
      canadianCarrierCode: null,
      timezone: "America/Winnipeg",
    },
    trip: {
      movementNumber: "ACE-1",
      tripNumber: "ABCD123456",
      portOfEntry: "0409",
      estimatedArrival: "2026-09-13T05:02:00.000Z",
      isEmpty: false,
      iitIndicator: "none",
      aci: { lvs: false, postal: false, flyingTruck: false, inTransit: false, iit: false },
    },
    crew: [
      {
        role: "person_in_charge",
        firstName: "Avery",
        lastName: "Driver",
        gender: "F",
        licenseNumber: "D1",
        licenseJurisdiction: "MB",
        citizenship: "CA",
        dateOfBirth: "1985-01-01",
        hazmatEndorsement: false,
        documents: [],
      },
    ],
    conveyance: {
      unitNumber: "T-101",
      vin: "1FUJA6CV12LJ12345",
      plate: "ABC123",
      plateJurisdiction: "MB",
      plates: [],
      truckType: "TR",
      dotNumber: null,
      insurance: null,
      seals: [],
    },
    equipment: [],
    shipments: [
      {
        controlNumber: "ABCDPAPS1",
        shipmentType: "regular_bill",
        cargoType: null,
        entryNumber: null,
        entryPort: null,
        inBond: null,
        loading: { country: "CA", province: "ND", city: "Pembina" },
        delivery: null,
        loadedOn: null,
        shipper: {
          name: "Shipper",
          address: null,
          postal: {
            line1: "1 Main St",
            line2: null,
            city: "Pembina",
            region: "ND",
            postalCode: "58271",
            country: "US",
          },
        },
        consignee: {
          name: "Consignee",
          address: null,
          postal: {
            line1: "2 Portage Ave",
            line2: null,
            city: "Winnipeg",
            region: "MB",
            postalCode: "R3C0B9",
            country: "CA",
          },
        },
        commodities: [
          {
            description: "Steel coils",
            hsCode: "720810",
            quantity: 1,
            quantityUnit: "coil",
            weightKg: 1000,
            weightUnit: "KG",
            packagingType: "Skid",
            marksAndNumbers: "LOT1",
            hazmat: [],
            countryOfOrigin: "CA",
            value: { amount: 5000, currency: "USD" },
          },
        ],
      },
    ],
    ...overrides,
  };
}

const trailer = (unitNumber: string) => ({
  unitNumber,
  type: "TF",
  plate: "GH4",
  plateJurisdiction: "ON",
  plates: [],
  seals: [],
});

describe("validateForBorderConnect — loadedOn (0051)", () => {
  it("passes a single trailer with nothing chosen (unambiguous default)", () => {
    const m = manifest({ equipment: [trailer("TR-501")] });
    expect(validateForBorderConnect(m)).toEqual([]);
  });

  it("refuses more than one trailer with nothing chosen", () => {
    const m = manifest({ equipment: [trailer("TR-501"), trailer("TR-502")] });
    expect(validateForBorderConnect(m)).toContain(
      "shipments[0].loadedOn: required when more than one trailer is attached",
    );
  });

  it("accepts an explicit choice on a double", () => {
    const src = manifest({ equipment: [trailer("TR-501"), trailer("TR-502")] });
    const m = {
      ...src,
      shipments: [{ ...src.shipments[0]!, loadedOn: { type: "TRAILER" as const, unitNumber: "TR-502" } }],
    };
    expect(validateForBorderConnect(m)).toEqual([]);
  });

  it("refuses an explicit unit that is not on this trip", () => {
    const src = manifest({ equipment: [trailer("TR-501")] });
    const m = {
      ...src,
      shipments: [
        { ...src.shipments[0]!, loadedOn: { type: "TRAILER" as const, unitNumber: "TR-999" } },
      ],
    };
    expect(validateForBorderConnect(m)).toContain(
      "shipments[0].loadedOn.number: TR-999 is not a unit on this trip",
    );
  });

  it("accepts an explicit TRUCK choice", () => {
    const m = {
      ...manifest({ equipment: [trailer("TR-501")] }),
    };
    m.shipments = [{ ...m.shipments[0]!, loadedOn: { type: "TRUCK", unitNumber: "T-101" } }];
    expect(validateForBorderConnect(m)).toEqual([]);
  });

  it("refuses a unit number that does not match BorderConnect's pattern", () => {
    const src = manifest({ equipment: [trailer("tr-501")] }); // lowercase — invalid
    const m = {
      ...src,
      shipments: [
        { ...src.shipments[0]!, loadedOn: { type: "TRAILER" as const, unitNumber: "tr-501" } },
      ],
    };
    expect(validateForBorderConnect(m)).toContain(
      "shipments[0].loadedOn.number: must be 1-17 characters of A-Z 0-9 space - / \\",
    );
  });

  it("refuses a unit number over 17 characters", () => {
    const long = "T".repeat(18);
    const src = manifest({ equipment: [trailer(long)] });
    const m = {
      ...src,
      shipments: [{ ...src.shipments[0]!, loadedOn: { type: "TRAILER" as const, unitNumber: long } }],
    };
    expect(validateForBorderConnect(m)).toContain(
      "shipments[0].loadedOn.number: must be 1-17 characters of A-Z 0-9 space - / \\",
    );
  });
});
