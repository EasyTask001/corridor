import { describe, expect, it } from "vitest";
import { moneyAmount } from "./movement";
import {
  SHIPMENT_TRANSITIONS,
  canTransitionShipment,
  commodityInput,
  controlReference,
  hazmatEntry,
  shipmentInput,
  shipmentStatus,
} from "./shipment";

describe("shipment state machine", () => {
  it("walks the happy path draft → sent → accepted → entry_on_file → released → arrived", () => {
    const path = [
      ["draft", "sent"],
      ["sent", "accepted"],
      ["accepted", "entry_on_file"],
      ["entry_on_file", "released"],
      ["released", "arrived"],
    ] as const;
    for (const [from, to] of path) expect(canTransitionShipment(from, to)).toBe(true);
  });

  it("mirrors the movement rules for held / rejected / cancelled", () => {
    expect(canTransitionShipment("sent", "rejected")).toBe(true);
    expect(canTransitionShipment("rejected", "draft")).toBe(true);
    expect(canTransitionShipment("accepted", "held")).toBe(true);
    expect(canTransitionShipment("held", "released")).toBe(true);
    expect(canTransitionShipment("draft", "cancelled")).toBe(true);
  });

  it("has no way out of arrived or cancelled, and every status is reachable in the table", () => {
    expect(SHIPMENT_TRANSITIONS.arrived).toEqual([]);
    expect(SHIPMENT_TRANSITIONS.cancelled).toEqual([]);
    expect(Object.keys(SHIPMENT_TRANSITIONS).sort()).toEqual([...shipmentStatus.options].sort());
  });

  it("rejects the transitions the DB check would also reject", () => {
    expect(canTransitionShipment("draft", "released")).toBe(false);
    expect(canTransitionShipment("entry_on_file", "sent")).toBe(false);
    expect(canTransitionShipment("arrived", "draft")).toBe(false);
  });
});

describe("shipmentInput", () => {
  const ace = {
    regime: "ACE" as const,
    shipmentType: "regular_bill" as const,
    controlReference: "paps0001",
  };

  it("uppercases the control reference and defaults the flags", () => {
    const parsed = shipmentInput.parse(ace);
    expect(parsed.controlReference).toBe("PAPS0001");
    expect(parsed.isPars).toBe(false);
  });

  it("rejects a control reference that is not 4–20 alphanumerics", () => {
    expect(controlReference.safeParse("AB1").success).toBe(false);
    expect(controlReference.safeParse("PAPS-0001").success).toBe(false);
    expect(controlReference.safeParse("A".repeat(21)).success).toBe(false);
  });

  it("requires the type field that matches the regime", () => {
    expect(shipmentInput.safeParse({ ...ace, shipmentType: undefined }).success).toBe(false);
    expect(shipmentInput.safeParse({ regime: "ACI", controlReference: "PARS0001" }).success).toBe(
      false,
    );
    expect(
      shipmentInput.safeParse({
        regime: "ACI",
        cargoType: "consolidated",
        controlReference: "PARS0001",
      }).success,
    ).toBe(true);
  });

  it("does not accept an ACE shipment type on an ACI shipment", () => {
    const parsed = shipmentInput.parse({
      regime: "ACI",
      cargoType: "regular",
      controlReference: "PARS0001",
      shipmentType: "in_bond",
    });
    expect("shipmentType" in parsed).toBe(false);
  });
});

describe("moneyAmount", () => {
  it("accepts cents-precision values up to numeric(14,2)", () => {
    expect(moneyAmount.parse(0)).toBe(0);
    expect(moneyAmount.parse(1234.56)).toBe(1234.56);
    expect(moneyAmount.parse(999_999_999_999.99)).toBe(999_999_999_999.99);
  });

  it("rejects sub-cent precision, negatives and values the column cannot hold", () => {
    expect(moneyAmount.safeParse(0.001).success).toBe(false);
    expect(moneyAmount.safeParse(-1).success).toBe(false);
    expect(moneyAmount.safeParse(1_000_000_000_000).success).toBe(false);
  });
});

describe("commodityInput", () => {
  it("defaults weightUnit to KG and hazmat to an empty list", () => {
    const parsed = commodityInput.parse({ commodityDescription: "Steel coils" });
    expect(parsed.weightUnit).toBe("KG");
    expect(parsed.hazmat).toEqual([]);
    expect(parsed.isConsolidated).toBe(false);
  });

  it("rejects negative weight and out-of-range confidence", () => {
    expect(
      commodityInput.safeParse({ commodityDescription: "Steel coils", weightKg: -1 }).success,
    ).toBe(false);
    expect(
      commodityInput.safeParse({ commodityDescription: "Steel coils", extractionConfidence: 1.2 })
        .success,
    ).toBe(false);
  });

  it("normalizes country code to uppercase", () => {
    const parsed = commodityInput.parse({
      commodityDescription: "Lumber",
      countryOfOrigin: "ca",
    });
    expect(parsed.countryOfOrigin).toBe("CA");
  });

  it("accepts at most three hazmat entries with UNnnnn codes", () => {
    expect(hazmatEntry.parse({ unCode: "un1203" }).unCode).toBe("UN1203");
    expect(hazmatEntry.safeParse({ unCode: "UN12" }).success).toBe(false);
    expect(
      commodityInput.safeParse({
        commodityDescription: "Fuel",
        hazmat: [{ unCode: "UN1203" }, { unCode: "UN1993" }, { unCode: "UN1863" }],
      }).success,
    ).toBe(true);
    expect(
      commodityInput.safeParse({
        commodityDescription: "Fuel",
        hazmat: [
          { unCode: "UN1203" },
          { unCode: "UN1993" },
          { unCode: "UN1863" },
          { unCode: "UN1170" },
        ],
      }).success,
    ).toBe(false);
  });
});
