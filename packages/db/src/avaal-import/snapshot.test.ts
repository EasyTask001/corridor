import { describe, expect, it } from "vitest";

import {
  AVAAL_CATEGORIES,
  snapshotCounts,
  validateSnapshot,
} from "./snapshot";

const completedCategory = {
  route: "/Masters/Driver/Driver",
  displayedTotal: 1,
  finalPageReached: true,
  pagesVisited: [1],
  records: [
    {
      sourceId: "driver-1",
      sourceUrl: "/Masters/Driver/Driver/1",
      fields: { Name: "A Driver", Active: true, Aliases: ["AD"] },
    },
  ],
  warnings: [],
};

const partialSnapshot = (category: unknown = completedCategory) => ({
  source: "avaal-ui",
  username: "pftrans",
  extractedAt: "2026-09-09T22:00:00.000Z",
  categories: { drivers: category },
});

describe("Avaal UI snapshot", () => {
  it("accepts a completed UI category and counts unique records", () => {
    const snapshot = validateSnapshot(partialSnapshot());

    expect(snapshotCounts(snapshot).drivers).toBe(1);
    expect(Object.keys(snapshotCounts(snapshot))).toEqual([...AVAAL_CATEGORIES]);
  });

  it.each([
    {
      name: "duplicate source IDs",
      category: {
        ...completedCategory,
        displayedTotal: 2,
        records: [
          { sourceId: "same", sourceUrl: "/one", fields: {} },
          { sourceId: "same", sourceUrl: "/two", fields: {} },
        ],
      },
    },
    {
      name: "unfinished pagination",
      category: { ...completedCategory, finalPageReached: false },
    },
    {
      name: "displayed-count mismatch",
      category: { ...completedCategory, displayedTotal: 2 },
    },
    {
      name: "non-contiguous page numbers",
      category: { ...completedCategory, pagesVisited: [1, 3] },
    },
    {
      name: "empty source identifiers",
      category: {
        ...completedCategory,
        records: [{ sourceId: "", sourceUrl: "", fields: {} }],
      },
    },
  ])("rejects $name", ({ category }) => {
    expect(() => validateSnapshot(partialSnapshot(category))).toThrow();
  });

  it("rejects unknown top-level keys", () => {
    expect(() => validateSnapshot({ ...partialSnapshot(), sessionCookie: "no" })).toThrow(
      /unknown/i,
    );
  });

  it("accepts an explicitly inapplicable category only with a reason", () => {
    const snapshot = validateSnapshot(
      partialSnapshot({ notApplicable: true, reason: "Not licensed in Avaal" }),
    );

    expect(snapshotCounts(snapshot).drivers).toBe(0);
    expect(() =>
      validateSnapshot(partialSnapshot({ notApplicable: true, reason: "" })),
    ).toThrow(/reason/i);
  });
});
