import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_DEVICE_QA_CASES, verifyDeviceQaEvidence } from "./verify-device-qa.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(here, "../../../docs/operations/mobile-device-qa.md");

/** Counts the scenario rows in the QA matrix table — every data row starts
 * with "| " followed by non-dash, non-empty text (skips the header separator
 * row of dashes). */
function scenarioRowCount(markdown) {
  const lines = markdown.split("\n").filter((l) => l.trim().startsWith("|"));
  const dataRows = lines.filter((l, i) => i > 0 && !/^\|[\s-]+\|/.test(l));
  return dataRows.length;
}

describe("mobile device QA gate matches the documented matrix", () => {
  it("REQUIRED_DEVICE_QA_CASES equals scenario rows × 2 devices (iPhone + Android)", () => {
    const markdown = readFileSync(DOC_PATH, "utf8");
    const rows = scenarioRowCount(markdown);
    expect(rows).toBeGreaterThan(0);
    expect(REQUIRED_DEVICE_QA_CASES).toBe(rows * 2);
  });

  it("rejects evidence with fewer cases than the matrix requires", () => {
    const cases = Array.from({ length: REQUIRED_DEVICE_QA_CASES - 1 }, () => ({
      status: "passed",
    }));
    expect(() =>
      verifyDeviceQaEvidence({
        cases,
        maestro: { status: "passed" },
        recordedAt: "2026-09-13",
        commit: "abc123",
      }),
    ).toThrow(/at least \d+ physical-device cases/);
  });

  it("accepts evidence with exactly the required number of passed cases", () => {
    const cases = Array.from({ length: REQUIRED_DEVICE_QA_CASES }, () => ({ status: "passed" }));
    expect(
      verifyDeviceQaEvidence({
        cases,
        maestro: { status: "passed" },
        recordedAt: "2026-09-13",
        commit: "abc123",
      }),
    ).toBe(REQUIRED_DEVICE_QA_CASES);
  });
});
