import { describe, expect, it } from "vitest";
import { REGULATION_CORPUS } from "./regulations-corpus";

describe("REGULATION_CORPUS provenance (0052)", () => {
  it("every entry carries authority, version and a retrievedAt date", () => {
    for (const reg of REGULATION_CORPUS) {
      expect(reg.authority, reg.source).toBeTruthy();
      expect(reg.version, reg.source).toBeTruthy();
      expect(reg.retrievedAt, reg.source).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("every entry is verified — nothing ships as an unchecked draft", () => {
    for (const reg of REGULATION_CORPUS) {
      expect(reg.lastVerifiedAt, `${reg.source} was never verified`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("URLs are https", () => {
    for (const reg of REGULATION_CORPUS) {
      expect(reg.url.startsWith("https://"), reg.source).toBe(true);
    }
  });

  // Regression guards for the two mistakes an earlier corpus shipped: citing
  // 19 CFR 149 (an *ocean* Importer Security Filing rule) for a truck
  // manifest requirement, and describing Release Prior to Payment as
  // something a carrier's bond secures rather than the importer's own CARM
  // security.
  it("never cites 19 CFR Part 149 for a truck manifest requirement", () => {
    for (const reg of REGULATION_CORPUS) {
      expect(reg.source).not.toMatch(/\b149\b/);
    }
  });

  it("describes Release Prior to Payment as an importer privilege, never a carrier bond", () => {
    const rpp = REGULATION_CORPUS.find((r) => /Release Prior to Payment/i.test(r.title));
    expect(rpp, "no RPP entry found").toBeTruthy();
    expect(rpp!.content).toMatch(/importer/i);
    // The old, wrong claim was "provided the carrier is bonded" — a
    // carrier's own bond may still be mentioned (to say it no longer
    // matters), so match the specific false claim, not any bond reference.
    expect(rpp!.content).not.toMatch(/carrier is bonded/i);
  });

  // A vendor pitch inside a "regulatory" excerpt is exactly the failure mode
  // this workstream exists to catch — the model would otherwise cite
  // Corridor's own product behaviour as if it were a rule of law.
  it("never mentions Corridor's own product inside a regulatory summary", () => {
    for (const reg of REGULATION_CORPUS) {
      expect(reg.content, reg.source).not.toMatch(/Corridor/);
    }
  });

  it("has no duplicate (source, title) pairs — the DB now enforces this too", () => {
    const seen = new Set<string>();
    for (const reg of REGULATION_CORPUS) {
      const key = `${reg.source}::${reg.title}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });
});
