import { beforeEach, describe, expect, it } from "vitest";
import { clearCustomsFixtureState, createFixtureStore, gatewayBonds } from "./fixture-state";

describe("createFixtureStore", () => {
  it("keys are tenant-scoped", () => {
    const s = createFixtureStore<string>({ maxEntries: 10, ttlMs: 1000 });
    s.set("a", "k", "va");
    s.set("b", "k", "vb");
    expect(s.get("a", "k")).toBe("va");
    expect(s.get("b", "k")).toBe("vb");
    expect(s.get("c", "k")).toBeUndefined();
  });
  it("the tenant+key composite is delimited, so a boundary shift cannot collide", () => {
    const s = createFixtureStore<string>({ maxEntries: 10, ttlMs: 1000 });
    s.set("ab", "c", "ab-c");
    s.set("a", "bc", "a-bc");
    expect(s.get("ab", "c")).toBe("ab-c");
    expect(s.get("a", "bc")).toBe("a-bc");
    expect(s.size).toBe(2);
  });
  it("evicts beyond maxEntries, least recently used first", () => {
    const s = createFixtureStore<number>({ maxEntries: 2, ttlMs: 1000 });
    s.set("t", "1", 1);
    s.set("t", "2", 2);
    expect(s.get("t", "1")).toBe(1); // touch "1" so "2" is now the oldest
    s.set("t", "3", 3);
    expect(s.size).toBe(2);
    expect(s.get("t", "2")).toBeUndefined();
    expect(s.get("t", "1")).toBe(1);
    expect(s.get("t", "3")).toBe(3);
  });
  it("expires entries after ttlMs", () => {
    let t = 1_000;
    const s = createFixtureStore<string>({ maxEntries: 10, ttlMs: 500, now: () => t });
    s.set("t", "k", "v");
    t += 499;
    expect(s.get("t", "k")).toBe("v");
    t += 1;
    expect(s.get("t", "k")).toBeUndefined();
    expect(s.size).toBe(0);
  });
});

describe("clearCustomsFixtureState", () => {
  beforeEach(clearCustomsFixtureState);
  it("empties the module singletons", () => {
    gatewayBonds.set("t", "123456789", "arrived");
    clearCustomsFixtureState();
    expect(gatewayBonds.get("t", "123456789")).toBeUndefined();
  });
});
