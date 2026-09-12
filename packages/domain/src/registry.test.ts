import { describe, expect, it } from "vitest";
import { addressColumnKeys, addressFromColumns, addressToColumns, nestAddress } from "./registry";

describe("addressToColumns", () => {
  it("flattens every part under the prefix and nulls the missing ones", () => {
    expect(addressToColumns("billing", { line1: "1 Corridor Way", city: "Mississauga" })).toEqual({
      billingLine1: "1 Corridor Way",
      billingLine2: null,
      billingCity: "Mississauga",
      billingRegion: null,
      billingPostalCode: null,
      billingCountry: null,
    });
  });
  it("trims, upper-cases the country and turns blanks into null", () => {
    expect(
      addressToColumns("address", { line1: "  400 Industrial Pkwy ", country: " ca ", region: "" }),
    ).toMatchObject({
      addressLine1: "400 Industrial Pkwy",
      addressCountry: "CA",
      addressRegion: null,
    });
  });
  it("null and undefined clear every column", () => {
    const cleared = Object.fromEntries(addressColumnKeys("usAddress").map((k) => [k, null]));
    expect(addressToColumns("usAddress", null)).toEqual(cleared);
    expect(addressToColumns("usAddress", undefined)).toEqual(cleared);
  });
});

describe("addressFromColumns", () => {
  it("omits null and blank columns so an empty address is {}", () => {
    expect(
      addressFromColumns("delivery", {
        deliveryLine1: null,
        deliveryCity: "",
        deliveryCountry: null,
      }),
    ).toEqual({});
  });
  it("upper-cases the country and ignores unrelated row keys", () => {
    expect(
      addressFromColumns("address", {
        id: "x",
        name: "Erie",
        addressCity: "Buffalo",
        addressCountry: "us",
      } as never),
    ).toEqual({ city: "Buffalo", country: "US" });
  });
  it("round-trips through addressToColumns", () => {
    const a = {
      line1: "88 Market Ave",
      city: "Buffalo",
      region: "NY",
      postalCode: "14203",
      country: "US",
    };
    expect(addressFromColumns("address", addressToColumns("address", a))).toEqual(a);
  });
});

describe("nestAddress", () => {
  it("replaces the flat columns with one nested key and keeps everything else", () => {
    const row = {
      id: "o1",
      name: "Pathfinder",
      billingLine1: "1 Corridor Way",
      billingLine2: null,
      billingCity: "Mississauga",
      billingRegion: "ON",
      billingPostalCode: "L5T 2M8",
      billingCountry: "CA",
    };
    expect(nestAddress("billing", "billingAddress", row)).toEqual({
      id: "o1",
      name: "Pathfinder",
      billingAddress: {
        line1: "1 Corridor Way",
        city: "Mississauga",
        region: "ON",
        postalCode: "L5T 2M8",
        country: "CA",
      },
    });
  });
});
