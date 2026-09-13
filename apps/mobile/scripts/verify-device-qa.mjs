/* global console, process */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// docs/operations/mobile-device-qa.md lists 14 scenarios, each run on both a
// physical iPhone and a physical Android handset — 28 cases total.
// verify-device-qa.test.mjs parses that table and asserts it still matches
// this constant, so the doc and the gate can no longer silently drift apart
// the way they did before (the doc had grown to 14 rows while this script
// still required only 23).
export const REQUIRED_DEVICE_QA_CASES = 28;

export function verifyDeviceQaEvidence(evidence) {
  if (!Array.isArray(evidence.cases) || evidence.cases.length < REQUIRED_DEVICE_QA_CASES) {
    throw new Error(
      `mobile evidence must contain at least ${REQUIRED_DEVICE_QA_CASES} physical-device cases`,
    );
  }
  const failed = evidence.cases.filter((testCase) => testCase?.status !== "passed");
  if (failed.length) throw new Error(`${failed.length} mobile QA case(s) are not marked passed`);
  if (evidence.maestro?.status !== "passed")
    throw new Error("Maestro golden path is not marked passed");
  if (!evidence.recordedAt || !evidence.commit)
    throw new Error("mobile evidence needs recordedAt and commit");
  return evidence.cases.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: verify-device-qa.mjs <evidence.json>");
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  const count = verifyDeviceQaEvidence(evidence);
  console.log(`verified ${count} mobile cases and Maestro golden path`);
}
