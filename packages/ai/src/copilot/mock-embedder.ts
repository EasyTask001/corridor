/**
 * Deterministic mock embedder — no network. Hashes text into a fixed-length
 * unit vector so cosine similarity is stable and testable: two texts sharing
 * more trigram tokens land closer together, so the mock is a genuine (if
 * crude) semantic proxy rather than pure noise. Same role as the mock
 * extractor in document-intelligence: used when no model key is configured,
 * in tests, and for any input containing "MOCK_EMBED".
 */
import type { Embedder, EmbeddingResult } from "./types";

export const MOCK_DIMENSIONS = 1536;

function trigrams(text: string): string[] {
  const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (norm.length < 3) return [norm];
  const out: string[] = [];
  for (let i = 0; i <= norm.length - 3; i++) out.push(norm.slice(i, i + 3));
  return out;
}

function hashToIndex(token: string, dims: number): number {
  let h = 2166136261;
  for (const ch of token) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % dims;
}

export function mockEmbed(text: string, dims: number = MOCK_DIMENSIONS): number[] {
  const vec = new Array<number>(dims).fill(0);
  for (const tri of trigrams(text)) {
    const idx = hashToIndex(tri, dims);
    vec[idx] = (vec[idx] ?? 0) + 1;
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

export const mockEmbedder: Embedder = {
  name: "mock",
  dimensions: MOCK_DIMENSIONS,
  async embed(text: string): Promise<EmbeddingResult> {
    return { embedding: mockEmbed(text), model: "mock" };
  },
  async embedMany(texts: string[]): Promise<EmbeddingResult[]> {
    return texts.map((t) => ({ embedding: mockEmbed(t), model: "mock" }));
  },
};
