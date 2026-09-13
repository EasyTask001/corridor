/* global console, process */
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("usage: verify-device-qa.mjs <evidence.json>");
const evidence = JSON.parse(readFileSync(path, "utf8"));
if (!Array.isArray(evidence.cases) || evidence.cases.length < 23) {
  throw new Error("mobile evidence must contain at least 23 physical-device cases");
}
const failed = evidence.cases.filter((testCase) => testCase?.status !== "passed");
if (failed.length) throw new Error(`${failed.length} mobile QA case(s) are not marked passed`);
if (evidence.maestro?.status !== "passed")
  throw new Error("Maestro golden path is not marked passed");
if (!evidence.recordedAt || !evidence.commit)
  throw new Error("mobile evidence needs recordedAt and commit");
console.log(`verified ${evidence.cases.length} mobile cases and Maestro golden path`);
