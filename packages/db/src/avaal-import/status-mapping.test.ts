import { describe, expect, it } from "vitest";

import {
  MigrationException,
  mapMovementStatus,
  mapShipmentStatus,
} from "./status-mapping";

describe("Avaal status mapping", () => {
  it.each([
    ["Released", "released"],
    ["On Hold", "held"],
    ["Rejected", "rejected"],
    ["ACCEPTED", "accepted"],
    ["Cancelled", "cancelled"],
  ])("maps movement status %s", (displayed, expected) => {
    expect(mapMovementStatus(displayed)).toBe(expected);
  });

  it.each([
    ["Arrived", "arrived"],
    ["Entry on File", "entry_on_file"],
    ["Released", "released"],
    ["Held", "held"],
  ])("maps shipment status %s", (displayed, expected) => {
    expect(mapShipmentStatus(displayed)).toBe(expected);
  });

  it("blocks unknown statuses instead of defaulting to draft", () => {
    expect(() => mapMovementStatus("Mystery State")).toThrow(MigrationException);
    expect(() => mapShipmentStatus("Mystery State")).toThrow(
      expect.objectContaining({ blocking: true }),
    );
  });
});
