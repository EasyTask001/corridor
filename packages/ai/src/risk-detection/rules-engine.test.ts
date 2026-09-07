import { describe, expect, it } from "vitest";
import { evaluateMovementRisk, hsDescriptionMismatch, type RiskInput } from "./rules-engine";

const baseInput: RiskInput = {
  movementId: "m1",
  hasBroker: true,
  cargo: [
    {
      lineNumber: 1,
      commodityDescription: "Hot-rolled steel coils",
      hsCode: "7208.10",
      weightKg: 21000,
      valueAmount: 48000,
    },
  ],
  lane: {
    weights: [20000, 21500, 19800, 20500],
    values: [47000, 49000, 46500, 48500],
    rejectedRecently: false,
  },
  lookupTariff: (code) =>
    code === "7208.10"
      ? { hsCode: "7208.10", description: "Flat-rolled iron/steel, hot-rolled, in coils" }
      : null,
};

describe("hsDescriptionMismatch", () => {
  it("finds overlap for a matching description", () => {
    expect(
      hsDescriptionMismatch("Hot-rolled steel coils", {
        hsCode: "x",
        description: "Flat-rolled iron/steel, hot-rolled, in coils",
      }),
    ).toBe(false);
  });
  it("flags no shared keywords", () => {
    expect(
      hsDescriptionMismatch("Fresh apples, bulk bins", {
        hsCode: "x",
        description: "Flat-rolled iron/steel, hot-rolled, in coils",
      }),
    ).toBe(true);
  });
});

describe("evaluateMovementRisk", () => {
  it("produces no findings for a normal, in-range shipment", () => {
    expect(evaluateMovementRisk(baseInput)).toEqual([]);
  });

  it("flags a weight outlier against the lane history", () => {
    const findings = evaluateMovementRisk({
      ...baseInput,
      cargo: [{ ...baseInput.cargo[0]!, weightKg: 95000 }],
    });
    const f = findings.find((x) => x.alertType === "risk_flag" && x.metadata.kind === "weight");
    expect(f).toBeDefined();
    expect(f!.title).toMatch(/above this lane's average/);
  });

  it("flags an HS code / description mismatch", () => {
    const findings = evaluateMovementRisk({
      ...baseInput,
      cargo: [{ ...baseInput.cargo[0]!, commodityDescription: "Fresh apples, bulk bins" }],
    });
    expect(findings.some((f) => f.alertType === "hs_code_mismatch")).toBe(true);
  });

  it("does not false-positive when the tariff lookup has no entry", () => {
    const findings = evaluateMovementRisk({ ...baseInput, lookupTariff: () => null });
    expect(findings.some((f) => f.alertType === "hs_code_mismatch")).toBe(false);
  });

  it("raises hold_prediction when enough risk factors combine, with reasons attached", () => {
    const findings = evaluateMovementRisk({
      ...baseInput,
      hasBroker: false,
      cargo: [
        {
          lineNumber: 1,
          commodityDescription: "Fresh apples, bulk bins",
          hsCode: "7208.10",
          weightKg: 95000,
          valueAmount: 90000,
        },
      ],
      lane: { ...baseInput.lane, rejectedRecently: true },
    });
    const hold = findings.find((f) => f.alertType === "hold_prediction");
    expect(hold).toBeDefined();
    expect(hold!.severity).toBe("critical");
    expect(hold!.description).toMatch(/rejected by customs/i);
    expect(hold!.description).toMatch(/no customs broker/i);
  });

  it("does not raise hold_prediction for a single minor factor", () => {
    const findings = evaluateMovementRisk(baseInput);
    expect(findings.some((f) => f.alertType === "hold_prediction")).toBe(false);
  });
});
