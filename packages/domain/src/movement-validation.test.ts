import { describe, expect, it } from "vitest";
import {
  hasBlockingIssues,
  validateForTransmit,
  type MovementForValidation,
} from "./movement-validation";

const TODAY = "2026-09-06";

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
  cargo: [
    {
      commodityDescription: "Steel coils",
      hsCode: "7208.10",
      weightKg: 20000,
      pieceCount: 10,
      shipperId: "s",
      consigneeId: "c",
      valueAmount: 50000,
      valueCurrency: "USD",
      countryOfOrigin: "CA",
    },
  ],
  seals: [{ sealNumber: "S1" }],
};

describe("validateForTransmit", () => {
  it("passes a complete movement", () => {
    const issues = validateForTransmit(ready, TODAY);
    expect(issues).toEqual([]);
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  it("blocks on missing driver, truck, crossing, carrier code and cargo", () => {
    const issues = validateForTransmit(
      { ...ready, driver: null, truck: null, port: null, carrierCode: null, cargo: [] },
      TODAY,
    );
    expect(issues.filter((i) => i.severity === "blocking").map((i) => i.code)).toEqual(
      expect.arrayContaining([
        "crossing_point_missing",
        "carrier_code_missing",
        "truck_missing",
        "driver_missing",
        "cargo_missing",
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

  it("requires shipper/consignee/weight/pieces per cargo line", () => {
    const issues = validateForTransmit(
      { ...ready, cargo: [{ commodityDescription: "x", shipperId: null, consigneeId: null }] },
      TODAY,
    );
    expect(issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        "cargo_0_shipper",
        "cargo_0_consignee",
        "cargo_0_weight",
        "cargo_0_pieces",
      ]),
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
