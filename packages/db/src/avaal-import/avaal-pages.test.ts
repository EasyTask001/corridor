import { describe, expect, it } from "vitest";

import { AVAAL_CATEGORIES } from "./snapshot";
import { AVAAL_EXTRACTION_ORDER, AVAAL_PAGE_CONFIGS } from "./avaal-pages";

describe("Avaal page map", () => {
  it("accounts for every migration category exactly once", () => {
    expect(Object.keys(AVAAL_PAGE_CONFIGS).sort()).toEqual([...AVAAL_CATEGORIES].sort());
    expect([...AVAAL_EXTRACTION_ORDER].sort()).toEqual([...AVAAL_CATEGORIES].sort());
    expect(new Set(AVAAL_EXTRACTION_ORDER)).toHaveProperty("size", AVAAL_CATEGORIES.length);
  });

  it("uses inspected UI routes and safe visible detail controls", () => {
    const allowedControls = ["View", "Edit", "Details", "row-link", "expand"];

    for (const category of AVAAL_CATEGORIES) {
      const config = AVAAL_PAGE_CONFIGS[category];
      expect(config.category).toBe(category);
      expect(config.route).toMatch(/^\//);
      if ("notApplicable" in config) {
        expect(config.notApplicable).toBe(true);
        expect(config.reason.trim()).not.toBe("");
        continue;
      }
      if (config.kind === "table") {
        expect(config.tableSelector).toMatch(/^#/);
        expect(config.displayedTotalSelector).toMatch(/^#/);
        expect(config.pagination?.nextSelector).toMatch(/^#/);
        expect(config.pagination?.activePageSelector).toContain(".current");
        if ("detail" in config && config.detail) {
          expect(allowedControls).toContain(config.detail.control);
        }
      }
    }
  });

  it("never configures a destructive source action", () => {
    const serialized = JSON.stringify(AVAAL_PAGE_CONFIGS);
    expect(serialized).not.toMatch(/"(?:Add|Save|Delete|Transmit|Amend|Cancel)"/i);
  });
});
