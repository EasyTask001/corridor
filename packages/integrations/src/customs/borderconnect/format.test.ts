import { describe, expect, it } from "vitest";
import { CustomsTransportError } from "../types";
import type { ManifestPayload } from "../types";
import { bcDateTime, tripNumberFor } from "./format";

/** Only `regime`/`carrier.code`/`trip.tripNumber`/`trip.movementNumber` matter here. */
function minimalManifest(overrides: {
  regime: "ACE" | "ACI";
  carrierCode: string;
  tripNumber: string | null;
  movementNumber: string;
}): ManifestPayload {
  return {
    regime: overrides.regime,
    carrier: {
      code: overrides.carrierCode,
      filerCode: null,
      usDotNumber: null,
      name: "Carrier",
      scac: null,
      canadianCarrierCode: null,
      timezone: "America/Toronto",
    },
    trip: {
      movementNumber: overrides.movementNumber,
      tripNumber: overrides.tripNumber,
      portOfEntry: "3801",
      estimatedArrival: "2026-01-01T14:00:00.000Z",
      isEmpty: false,
      iitIndicator: "none",
      aci: { lvs: false, postal: false, flyingTruck: false, inTransit: false, iit: false },
    },
    crew: [],
    conveyance: {
      unitNumber: "T-1",
      vin: null,
      plate: "AB1",
      plateJurisdiction: "ON",
      plates: [],
      truckType: "TR",
      dotNumber: null,
      insurance: null,
      seals: [],
    },
    equipment: [],
    shipments: [],
  };
}

describe("tripNumberFor", () => {
  it("ACE: reuses trip.tripNumber when it already matches the pattern", () => {
    const m = minimalManifest({
      regime: "ACE",
      carrierCode: "PFTR",
      tripNumber: "PFTR12345",
      movementNumber: "ACE-26-00001",
    });
    expect(tripNumberFor(m)).toBe("PFTR12345");
  });

  it("ACE: derives from carrier code + movement number when tripNumber is absent", () => {
    const m = minimalManifest({
      regime: "ACE",
      carrierCode: "PFTR",
      tripNumber: null,
      movementNumber: "ACE-26-00001",
    });
    expect(tripNumberFor(m)).toBe("PFTRACE2600001");
  });

  it("ACE: derives when tripNumber is present but does not match the pattern", () => {
    const m = minimalManifest({
      regime: "ACE",
      carrierCode: "PFTR",
      tripNumber: "1",
      movementNumber: "ACE-26-00001",
    });
    expect(tripNumberFor(m)).toBe("PFTRACE2600001");
  });

  it("ACE: throws a 422 when neither the trip number nor the derived one fits the pattern", () => {
    const m = minimalManifest({
      regime: "ACE",
      carrierCode: "P1", // not 4 letters -> derived candidate also fails
      tripNumber: null,
      movementNumber: "26-1",
    });
    expect(() => tripNumberFor(m)).toThrow(CustomsTransportError);
    try {
      tripNumberFor(m);
      throw new Error("expected tripNumberFor to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CustomsTransportError);
      expect((e as CustomsTransportError).statusCode).toBe(422);
      expect((e as CustomsTransportError).message).toBe(
        "trip.tripNumber: must start with the carrier code and be 8–25 alphanumerics",
      );
    }
  });

  it("ACI: normalises O->0 and I->1 in a trip number that already fits the pattern", () => {
    const m = minimalManifest({
      regime: "ACI",
      carrierCode: "PFTR",
      tripNumber: "PFTROI234561",
      movementNumber: "ACI-26-00007",
    });
    expect(tripNumberFor(m)).toBe("PFTR01234561");
  });

  it("ACI: normalises the derived candidate too", () => {
    const m = minimalManifest({
      regime: "ACI",
      carrierCode: "PFTR",
      tripNumber: null,
      movementNumber: "ACI-26-00007",
    });
    // derived: PFTR + ACI2600007 -> "PFTRACI2600007", normalised O/I -> "PFTRAC12600007"
    expect(tripNumberFor(m)).toBe("PFTRAC12600007");
  });
});

describe("bcDateTime", () => {
  it("rounds :37 down to :30", () => {
    expect(bcDateTime("2026-01-01T14:37:00.000Z", "UTC")).toBe("2026-01-01 14:30:00");
  });

  it("rounds :38 up to :45", () => {
    expect(bcDateTime("2026-01-01T14:38:00.000Z", "UTC")).toBe("2026-01-01 14:45:00");
  });

  it("rounding a 23:53 carries into the next day", () => {
    expect(bcDateTime("2026-01-01T23:53:00.000Z", "UTC")).toBe("2026-01-02 00:00:00");
  });

  it("computes the wall-clock time in the given IANA timezone, not UTC", () => {
    // 2026-01-01T20:00:00Z is 15:00 in America/Toronto (EST, UTC-5) in January.
    expect(bcDateTime("2026-01-01T20:00:00.000Z", "America/Toronto")).toBe("2026-01-01 15:00:00");
  });
});
