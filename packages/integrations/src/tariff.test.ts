import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TARIFF_CACHE_TTL_MS,
  clearTariffCache,
  configureTariffCache,
  lookupHsCode,
  resetTariffCache,
  searchTariff,
  type TariffEntry,
} from "./tariff";

const ENTRY: TariffEntry = {
  hsCode: "7208.10",
  description: "Flat-rolled iron/steel",
  usDutyRate: 0,
  caDutyRate: 0,
};

/** A source that counts calls, plus a clock the test moves by hand. */
function harness(startedAt = 1_700_000_000_000) {
  let clock = startedAt;
  const lookup = vi.fn((): TariffEntry | null => ENTRY);
  const search = vi.fn((): TariffEntry[] => [ENTRY]);
  configureTariffCache({ source: { lookup, search }, now: () => clock });
  return { lookup, search, advance: (ms: number) => (clock += ms) };
}

afterEach(() => resetTariffCache());

describe("tariff cache", () => {
  it("serves a repeat lookup from cache within the TTL", () => {
    const { lookup, advance } = harness();

    expect(lookupHsCode("7208.10")).toEqual(ENTRY);
    advance(TARIFF_CACHE_TTL_MS - 1);
    expect(lookupHsCode(" 7208.10 ")).toEqual(ENTRY); // normalised to the same key
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("re-reads once the TTL has elapsed", () => {
    const { lookup, advance } = harness();

    lookupHsCode("7208.10");
    advance(TARIFF_CACHE_TTL_MS + 1);
    lookupHsCode("7208.10");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("caches searches per query and limit", () => {
    const { search } = harness();

    expect(searchTariff("Steel")).toEqual([ENTRY]);
    searchTariff("steel"); // case-normalised → same key
    expect(search).toHaveBeenCalledTimes(1);

    searchTariff("steel", 3); // a different limit is a different result set
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("never touches the source for a blank query", () => {
    const { lookup, search } = harness();

    expect(lookupHsCode("")).toBeNull();
    expect(lookupHsCode(null)).toBeNull();
    expect(searchTariff("  ")).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("clearTariffCache forces the next read through", () => {
    const { lookup } = harness();

    lookupHsCode("7208.10");
    clearTariffCache();
    lookupHsCode("7208.10");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry instead of growing without bound", () => {
    const { search } = harness();

    for (let i = 0; i < 501; i++) searchTariff(`query-${i}`);
    expect(search).toHaveBeenCalledTimes(501);

    searchTariff("query-500"); // newest — still cached
    expect(search).toHaveBeenCalledTimes(501);
    searchTariff("query-0"); // oldest — evicted, so read through again
    expect(search).toHaveBeenCalledTimes(502);
  });

  it("still answers from the built-in table once reset", () => {
    resetTariffCache();
    expect(lookupHsCode("7208.10")?.description).toMatch(/hot-rolled/i);
    expect(searchTariff("apples")[0]?.hsCode).toBe("0808.10");
  });
});
