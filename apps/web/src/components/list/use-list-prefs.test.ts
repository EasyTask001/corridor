import { describe, expect, it } from "vitest";
import { parseListPrefs } from "./use-list-prefs";

const defaults = { columns: ["a", "b"], pageSize: 25, autoRefreshSec: 0 };
const valid = ["a", "b", "c"];

describe("parseListPrefs", () => {
  it("returns the defaults for nothing stored or garbage", () => {
    expect(parseListPrefs(null, defaults, valid)).toBe(defaults);
    expect(parseListPrefs("{not json", defaults, valid)).toBe(defaults);
    expect(parseListPrefs('"a string"', defaults, valid)).toBe(defaults);
  });

  it("keeps only known columns, in canonical order, and known sizes and intervals", () => {
    expect(parseListPrefs(JSON.stringify({ columns: ["c", "zz", "a"], pageSize: 50, autoRefreshSec: 60 }), defaults, valid)).toEqual({
      columns: ["a", "c"],
      pageSize: 50,
      autoRefreshSec: 60,
    });
  });

  it("falls back per field", () => {
    expect(parseListPrefs(JSON.stringify({ columns: ["zz"], pageSize: 7, autoRefreshSec: 12 }), defaults, valid)).toEqual(defaults);
  });
});
