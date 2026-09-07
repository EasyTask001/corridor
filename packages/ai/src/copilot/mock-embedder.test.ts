import { describe, expect, it } from "vitest";
import { mockEmbed, mockEmbedder } from "./mock-embedder";
import { REGULATION_CORPUS } from "./regulations-corpus";
import { MIN_CITATION_SIMILARITY, minCitationSimilarity } from "./types";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // both are already unit vectors
}

describe("mockEmbed", () => {
  it("is deterministic", () => {
    expect(mockEmbed("hello world")).toEqual(mockEmbed("hello world"));
  });

  it("returns a unit vector of the requested dimensionality", () => {
    const v = mockEmbed("some text", 64);
    expect(v).toHaveLength(64);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("scores near-duplicate text as more similar than unrelated text", () => {
    const a = mockEmbed("HS code 7208.10 covers hot-rolled steel coils");
    const b = mockEmbed("HS code 7208.10 covers hot rolled steel coil imports");
    const c = mockEmbed("Fresh apples must be declared with a phytosanitary certificate");
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });

  /**
   * Regression guard for a mock-mode copilot that answered with no sources:
   * the mock's cosine scale sits far below the model-calibrated citation gate,
   * so retrieval filtered out even the correct chunk.
   */
  it("ranks the right regulation first, but below the model citation gate", () => {
    const question = mockEmbed("What documents are required for an ACE e-manifest?");
    const ranked = REGULATION_CORPUS.map((r) => ({
      title: r.title,
      similarity: cosine(question, mockEmbed(r.content)),
    })).sort((a, b) => b.similarity - a.similarity);

    expect(ranked[0]!.title).toBe(
      "Advance Electronic Information for Truck Cargo (ACE e-Manifest)",
    );
    expect(ranked[0]!.similarity).toBeLessThan(MIN_CITATION_SIMILARITY);
    expect(ranked[0]!.similarity).toBeGreaterThanOrEqual(minCitationSimilarity("mock"));
  });

  it("embedder interface matches embed/embedMany contracts", async () => {
    const single = await mockEmbedder.embed("test");
    expect(single.embedding).toHaveLength(1536);
    expect(single.model).toBe("mock");
    const many = await mockEmbedder.embedMany(["a", "b", "c"]);
    expect(many).toHaveLength(3);
    expect(many[0]!.embedding).toEqual(mockEmbed("a"));
  });
});
