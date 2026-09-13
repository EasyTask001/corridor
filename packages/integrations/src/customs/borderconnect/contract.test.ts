import { describe, expect, it } from "vitest";
import type { ManifestPayload } from "../types";
import { toAceTrip } from "./ace";
import { toAciTrip } from "./aci";
import { toCancelSendRequest } from "./send-request";

const manifest = (regime: "ACE" | "ACI"): ManifestPayload => ({
  regime,
  carrier: {
    code: regime === "ACE" ? "ABCD" : "1234",
    filerCode: null,
    usDotNumber: null,
    name: "Carrier",
    scac: regime === "ACE" ? "ABCD" : null,
    canadianCarrierCode: regime === "ACI" ? "1234" : null,
    timezone: "America/Winnipeg",
  },
  trip: {
    movementNumber: regime + "-1",
    tripNumber: regime === "ACE" ? "ABCD123456" : "1234123456",
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
      documents: [
        {
          type: "passport",
          number: "P123456",
          issuingCountry: "CA",
          issuingState: null,
          expiresOn: "2030-01-01",
        },
      ],
    },
  ],
  conveyance: {
    unitNumber: "T1",
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
      controlNumber: regime === "ACE" ? "ABCDPAPS1" : "1234PARS1",
      shipmentType: regime === "ACE" ? "regular_bill" : null,
      cargoType: regime === "ACI" ? "regular" : null,
      entryNumber: null,
      entryPort: null,
      inBond: null,
      loading: { country: regime === "ACE" ? "CA" : "US", province: "ND", city: "Pembina" },
      delivery: null,
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
});

const opts = {
  companyKey: "c-service-provider",
  sendId: "send-1",
  operation: "CREATE" as const,
  autoSend: false,
};

describe("BorderConnect contract matrix", () => {
  it("is published as an executable contract", async () => {
    await expect(import("./contract")).resolves.toMatchObject({
      BORDERCONNECT_CONTRACT_MATRIX: expect.any(Array),
      validateBorderConnectContract: expect.any(Function),
    });
  });

  it("versions every field against a manual and mapper source", async () => {
    const { BORDERCONNECT_CONTRACT_MATRIX } = await import("./contract");
    expect(BORDERCONNECT_CONTRACT_MATRIX.length).toBeGreaterThan(50);
    for (const field of BORDERCONNECT_CONTRACT_MATRIX) {
      expect(field.externalPath).toMatch(/^(aceTrip|aciTrip|aceSendRequest|aciSendRequest)\./);
      expect(field.manualVersion).toMatch(/^1\.0\.[267]$/);
      expect(field.mapperSource).toMatch(/\.ts$/);
      expect(["string", "number", "boolean", "object", "array"]).toContain(field.type);
      expect(typeof field.required).toBe("boolean");
      expect(field).toHaveProperty("minLength");
      expect(field).toHaveProperty("maxLength");
      expect(field).toHaveProperty("pattern");
    }
  });

  it("accepts every emitted ACE, ACI, and cancellation field", async () => {
    const { validateBorderConnectContract } = await import("./contract");
    expect(validateBorderConnectContract("ACE_TRIP", toAceTrip(manifest("ACE"), opts))).toEqual([]);
    expect(validateBorderConnectContract("ACI_TRIP", toAciTrip(manifest("ACI"), opts))).toEqual([]);
    expect(
      validateBorderConnectContract(
        "ACE_SEND_REQUEST",
        toCancelSendRequest("ACE", "ABCD123456", opts),
      ),
    ).toEqual([]);
    expect(
      validateBorderConnectContract(
        "ACI_SEND_REQUEST",
        toCancelSendRequest("ACI", "1234123456", opts),
      ),
    ).toEqual([]);
  });

  it("rejects the obsolete trip ETA key", async () => {
    const { validateBorderConnectContract } = await import("./contract");
    const payload = toAceTrip(manifest("ACE"), opts);
    payload.estimatedArrivalDate = payload.estimatedArrivalDateTime;
    delete payload.estimatedArrivalDateTime;

    expect(validateBorderConnectContract("ACE_TRIP", payload)).toEqual(
      expect.arrayContaining([
        "aceTrip.estimatedArrivalDate: field is not in ACE eManifest manual 1.0.7",
        "aceTrip.estimatedArrivalDateTime: required",
      ]),
    );
  });

  it("enforces the required 19-character trip ETA format", async () => {
    const { validateBorderConnectContract } = await import("./contract");
    const payload = toAciTrip(manifest("ACI"), opts);
    payload.estimatedArrivalDateTime = "2026-09-13";

    expect(validateBorderConnectContract("ACI_TRIP", payload)).toEqual(
      expect.arrayContaining([
        "aciTrip.estimatedArrivalDateTime: must be at least 19 characters",
        "aciTrip.estimatedArrivalDateTime: must match ^[2-9][0-9]{3}-[0-1][0-9]-[0-3][0-9]\\s[0-2][0-9]:[0-5][0-9]:[0-5][0-9]$",
      ]),
    );
  });

  it("rejects required arrays that are present but empty", async () => {
    const { validateBorderConnectContract } = await import("./contract");
    const payload = toAceTrip(manifest("ACE"), opts);
    payload.drivers = [];
    expect(validateBorderConnectContract("ACE_TRIP", payload)).toEqual(
      expect.arrayContaining(["aceTrip.drivers: required"]),
    );
  });

  // Both the ACE and ACI JSON reference manuals cap trailers[].number at 15
  // characters (not 17, which is the limit for the sibling loadedOn.number
  // field) — a discrepancy the matrix used to carry. Guard it explicitly so
  // it can't silently drift back.
  it("caps trailers[].number at 15 characters for both regimes", async () => {
    const { validateBorderConnectContract } = await import("./contract");
    const trailer = {
      number: "TOOLONGTRAILER16", // 16 chars
      type: "DT",
      licensePlates: [{ number: "ABC123", stateProvince: "MB" }],
      sealNumbers: [],
    };

    const acePayload = toAceTrip(manifest("ACE"), opts);
    acePayload.trailers = [trailer];
    expect(validateBorderConnectContract("ACE_TRIP", acePayload)).toEqual(
      expect.arrayContaining(["aceTrip.trailers[].number: must be at most 15 characters"]),
    );

    const aciPayload = toAciTrip(manifest("ACI"), opts);
    aciPayload.trailers = [{ ...trailer, licensePlate: trailer.licensePlates[0] }];
    expect(validateBorderConnectContract("ACI_TRIP", aciPayload)).toEqual(
      expect.arrayContaining(["aciTrip.trailers[].number: must be at most 15 characters"]),
    );
  });
});
