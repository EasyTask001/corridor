import { describe, expect, it } from "vitest";
import { amendmentInput } from "./movement-inputs";
import { shipmentInput, shipmentPatch } from "./shipment";

const MOVEMENT_ID = "11111111-1111-4111-8111-111111111111";
const SHIPMENT_ID = "22222222-2222-4222-8222-222222222222";

describe("amendmentInput", () => {
  const base = { movementId: MOVEMENT_ID, reason: "Correct filing", patch: { tripNumber: "T-2" } };

  it("accepts an explicit trip amendment scope", () => {
    expect(amendmentInput.parse({ ...base, scope: "trip" }).scope).toBe("trip");
  });

  it("requires a shipment id for shipment-scoped amendments", () => {
    expect(amendmentInput.safeParse({ ...base, scope: "shipment" }).success).toBe(false);
    expect(
      amendmentInput.safeParse({ ...base, scope: "shipment", shipmentId: SHIPMENT_ID }).success,
    ).toBe(true);
  });

  it("rejects a shipment id on a trip-scoped amendment", () => {
    expect(
      amendmentInput.safeParse({ ...base, scope: "trip", shipmentId: SHIPMENT_ID }).success,
    ).toBe(false);
  });
});

describe("shipment broker input", () => {
  const brokerId = "33333333-3333-4333-8333-333333333333";

  it("preserves broker assignment on create and edit", () => {
    expect(
      shipmentInput.parse({
        regime: "ACE",
        shipmentType: "regular_bill",
        controlReference: "PAPS1001",
        brokerId,
      }).brokerId,
    ).toBe(brokerId);
    expect(shipmentPatch.parse({ brokerId }).brokerId).toBe(brokerId);
    expect(shipmentPatch.parse({ brokerId: null }).brokerId).toBeNull();
  });
});
