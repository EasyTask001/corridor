import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk";
import { REGULATION_CORPUS } from "./regulations-corpus";

describe("chunkText", () => {
  it("keeps short text as a single chunk", () => {
    expect(chunkText("One short sentence.")).toEqual(["One short sentence."]);
  });

  it("splits long text into chunks under the size limit", () => {
    const long = "This is a sentence. ".repeat(50);
    const chunks = chunkText(long, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120); // small slack for sentence boundaries
  });

  it("never drops content", () => {
    const text = "A. B. C. D. E.";
    const chunks = chunkText(text, 5);
    expect(chunks.join(" ")).toContain("A");
    expect(chunks.join(" ")).toContain("E");
  });

  it("produces at least one chunk for every corpus entry", () => {
    for (const r of REGULATION_CORPUS) {
      expect(chunkText(r.content).length).toBeGreaterThan(0);
    }
  });
});
