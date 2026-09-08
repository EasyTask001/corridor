import { describe, expect, it } from "vitest";
import { authCookieOptions, persistSessionFrom } from "./cookies";

describe("stay signed in", () => {
  it("keeps the lifetime when persisting and strips it otherwise", () => {
    const base = { maxAge: 31536000, expires: new Date(0), path: "/" };
    expect(authCookieOptions(base, true)).toBe(base);
    expect(authCookieOptions(base, false)).toEqual({ path: "/" });
  });
  it("reads the choice from cookies", () => {
    const jar = new Map([["corridor-persist", { value: "1" }]]);
    expect(persistSessionFrom(jar)).toBe(true);
    expect(persistSessionFrom(new Map())).toBe(false);
  });
});
