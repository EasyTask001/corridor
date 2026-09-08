import { describe, expect, it } from "vitest";
import { CROSSING_REPORT_COLUMNS } from "@corridor/domain";
import { csvField, pickColumns, toCsv } from "./reporting-export";

describe("csv escaping", () => {
  it("quotes only when needed and doubles embedded quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(12.5)).toBe("12.5");
    expect(csvField(null)).toBe("");
    expect(csvField('Maple "Ridge", Ltd')).toBe('"Maple ""Ridge"", Ltd"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });

  it("writes a BOM, a header row and CRLF line ends", () => {
    const csv = toCsv(
      [
        { key: "a", label: "A" },
        { key: "b", label: "B, or not" },
      ],
      [
        { a: "1", b: "x" },
        { a: 2, b: null },
      ],
    );
    expect(csv).toBe('\uFEFFA,"B, or not"\r\n1,x\r\n2,\r\n');
  });
});

describe("column selection", () => {
  it("keeps the picked columns in the picked order and drops unknown keys", () => {
    const picked = pickColumns(CROSSING_REPORT_COLUMNS, ["truckUnit", "movementNumber", "nope" as never]);
    expect(picked.map((c) => c.key)).toEqual(["truckUnit", "movementNumber"]);
    expect(picked[1]?.label).toBe("Movement");
  });
});
