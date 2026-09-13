import { describe, expect, it } from "vitest";
import { loadedOnInput, resolveLoadedOn, setLoadedOnInput, type LoadedOnUnits } from "./loaded-on";

const truckOnly: LoadedOnUnits = { truckUnitNumber: "T-101", trailers: [] };
const oneTrailer: LoadedOnUnits = {
  truckUnitNumber: "T-101",
  trailers: [{ id: "mt-1", unitNumber: "TR-501" }],
};
const twoTrailers: LoadedOnUnits = {
  truckUnitNumber: "T-101",
  trailers: [
    { id: "mt-1", unitNumber: "TR-501" },
    { id: "mt-2", unitNumber: "TR-502" },
  ],
};

describe("resolveLoadedOn", () => {
  describe("no explicit value — BorderConnect's documented default", () => {
    it("bobtail: resolves to the truck", () => {
      expect(resolveLoadedOn(truckOnly, null)).toEqual({
        type: "TRUCK",
        unitNumber: "T-101",
        explicit: false,
      });
    });

    it("one trailer: resolves to it, unambiguously", () => {
      expect(resolveLoadedOn(oneTrailer, null)).toEqual({
        type: "TRAILER",
        unitNumber: "TR-501",
        explicit: false,
      });
    });

    it("two trailers: ambiguous — the filer must choose", () => {
      expect(resolveLoadedOn(twoTrailers, null)).toEqual({ type: "ambiguous" });
    });

    it("no truck and no trailers: nothing to resolve to", () => {
      expect(resolveLoadedOn({ truckUnitNumber: null, trailers: [] }, null)).toEqual({
        type: "stale",
      });
    });
  });

  describe("explicit TRUCK", () => {
    it("resolves to the truck even with trailers hitched", () => {
      expect(resolveLoadedOn(twoTrailers, { type: "TRUCK" })).toEqual({
        type: "TRUCK",
        unitNumber: "T-101",
        explicit: true,
      });
    });

    it("is stale when there is no truck", () => {
      expect(resolveLoadedOn({ truckUnitNumber: null, trailers: [] }, { type: "TRUCK" })).toEqual({
        type: "stale",
      });
    });
  });

  describe("explicit TRAILER", () => {
    it("resolves to the named slot on a double", () => {
      expect(
        resolveLoadedOn(twoTrailers, { type: "TRAILER", movementTrailerId: "mt-2" }),
      ).toEqual({ type: "TRAILER", unitNumber: "TR-502", explicit: true });
    });

    it("is stale once the slot is no longer on the trip (dropped or reassigned)", () => {
      expect(
        resolveLoadedOn(oneTrailer, { type: "TRAILER", movementTrailerId: "mt-9-gone" }),
      ).toEqual({ type: "stale" });
    });
  });
});

describe("loadedOnInput", () => {
  it("accepts TRUCK with no id", () => {
    expect(loadedOnInput.safeParse({ type: "TRUCK" }).success).toBe(true);
  });

  it("accepts TRAILER only with a movementTrailerId uuid", () => {
    expect(
      loadedOnInput.safeParse({
        type: "TRAILER",
        movementTrailerId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
    expect(loadedOnInput.safeParse({ type: "TRAILER" }).success).toBe(false);
    expect(
      loadedOnInput.safeParse({ type: "TRAILER", movementTrailerId: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("rejects an unknown type", () => {
    expect(loadedOnInput.safeParse({ type: "CONTAINER" }).success).toBe(false);
  });
});

describe("setLoadedOnInput", () => {
  const id = "11111111-1111-4111-8111-111111111111";

  it("accepts a null loadedOn (clearing the placement)", () => {
    expect(setLoadedOnInput.safeParse({ id, loadedOn: null }).success).toBe(true);
  });

  it("accepts an explicit TRUCK or TRAILER value", () => {
    expect(setLoadedOnInput.safeParse({ id, loadedOn: { type: "TRUCK" } }).success).toBe(true);
    expect(
      setLoadedOnInput.safeParse({
        id,
        loadedOn: { type: "TRAILER", movementTrailerId: id },
      }).success,
    ).toBe(true);
  });

  it("requires the shipment id", () => {
    expect(setLoadedOnInput.safeParse({ loadedOn: null }).success).toBe(false);
  });
});
