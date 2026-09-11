import { describe, expect, it } from "vitest";
import { appendPage, type Page } from "./use-paged";

interface Row {
  id: string;
  title: string;
}

const page = (rows: Row[], nextCursor: string | null): Page<Row> => ({ rows, nextCursor });

describe("appendPage", () => {
  it("starts a fresh page when there is no previous page", () => {
    const next = page([{ id: "1", title: "a" }], "c1");
    expect(appendPage(undefined, next)).toEqual(next);
  });

  it("appends new rows after the existing ones", () => {
    const prev = page([{ id: "1", title: "a" }], "c1");
    const next = page([{ id: "2", title: "b" }], "c2");
    expect(appendPage(prev, next)).toEqual({
      rows: [
        { id: "1", title: "a" },
        { id: "2", title: "b" },
      ],
      nextCursor: "c2",
    });
  });

  it("de-duplicates rows that appear in both pages", () => {
    const prev = page(
      [
        { id: "1", title: "a" },
        { id: "2", title: "b" },
      ],
      "c1",
    );
    const next = page(
      [
        { id: "2", title: "b (refetched)" },
        { id: "3", title: "c" },
      ],
      "c2",
    );
    expect(appendPage(prev, next)).toEqual({
      rows: [
        { id: "1", title: "a" },
        { id: "2", title: "b" },
        { id: "3", title: "c" },
      ],
      nextCursor: "c2",
    });
  });

  it("carries the last page's cursor forward, including null when exhausted", () => {
    const prev = page([{ id: "1", title: "a" }], "c1");
    const next = page([{ id: "2", title: "b" }], null);
    expect(appendPage(prev, next).nextCursor).toBeNull();
  });
});
