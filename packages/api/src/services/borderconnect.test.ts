import { describe, expect, it } from "vitest";
import { canonicalStringify } from "./borderconnect";

describe("canonicalStringify", () => {
  it("is insensitive to top-level key order", () => {
    expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
  });

  it("is insensitive to nested object key order", () => {
    const left = { data: "API_RESPONSE", meta: { sendId: "s1", tripNumber: "t1" } };
    const right = { meta: { tripNumber: "t1", sendId: "s1" }, data: "API_RESPONSE" };
    expect(canonicalStringify(left)).toBe(canonicalStringify(right));
  });

  it("preserves array element order (arrays are not sorted)", () => {
    expect(canonicalStringify([1, 2, 3])).not.toBe(canonicalStringify([3, 2, 1]));
    expect(canonicalStringify({ errors: [{ a: 1 }, { b: 2 }] })).toBe(
      canonicalStringify({ errors: [{ a: 1 }, { b: 2 }] }),
    );
  });

  it("still distinguishes genuinely different content", () => {
    expect(canonicalStringify({ a: 1, b: 2 })).not.toBe(canonicalStringify({ a: 1, b: 3 }));
    expect(canonicalStringify({ a: 1 })).not.toBe(canonicalStringify({ a: 1, b: null }));
  });

  it("treats an object with an undefined value like JSON.stringify (key omitted)", () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toBe(canonicalStringify({ a: 1 }));
  });

  it("handles primitives and null", () => {
    expect(canonicalStringify("x")).toBe(JSON.stringify("x"));
    expect(canonicalStringify(42)).toBe("42");
    expect(canonicalStringify(true)).toBe("true");
    expect(canonicalStringify(null)).toBe("null");
  });
});
