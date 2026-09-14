import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseInbound } from "./inbound";

const here = dirname(fileURLToPath(import.meta.url));
const LIVE_DIR = join(here, "fixtures", "inbound", "live");

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const basenames = readdirSync(LIVE_DIR)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".expected.json"))
  .map((f) => f.replace(/\.json$/, ""));

describe("live BorderConnect fixtures (promoted from a real inbox)", () => {
  if (basenames.length === 0) {
    it.skip("none promoted yet — see fixtures/inbound/live/README.md", () => {});
    return;
  }

  for (const basename of basenames) {
    it(`${basename}: parseInbound matches its recorded expectation`, () => {
      const message = loadJson(join(LIVE_DIR, `${basename}.json`));
      const expected = loadJson(join(LIVE_DIR, `${basename}.expected.json`));
      expect(parseInbound(message)).toMatchObject(expected as Record<string, unknown>);
    });
  }
});
