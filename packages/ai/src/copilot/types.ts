export interface EmbeddingResult {
  embedding: number[];
  model: string;
}

export interface Embedder {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<EmbeddingResult>;
  embedMany(texts: string[]): Promise<EmbeddingResult[]>;
}

export interface RegulationMatch {
  regulationDocumentId: string;
  title: string;
  source: string;
  jurisdiction: "US" | "CA";
  url: string | null;
  chunkIndex: number;
  content: string;
  similarity: number;
}

export interface OrgKnowledgeMatch {
  id: string;
  sourceType: "movement_note" | "hold_resolution" | "sop_document";
  sourceId: string | null;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export interface RetrievedContext {
  regulations: RegulationMatch[];
  orgKnowledge: OrgKnowledgeMatch[];
}

/** Below this cosine similarity, a chunk is too weak to cite as an answer basis. */
export const MIN_CITATION_SIMILARITY = 0.5;

/**
 * The same gate for the deterministic mock embedder. Its trigram-hash vectors
 * are sparse, so cosine similarity between a short question and a paragraph
 * sits an order of magnitude lower than a real embedding model's (~0.25 for a
 * strong match, not ~0.55) — the model-calibrated gate rejects *every* chunk
 * and the copilot answers with no citations at all when no AI key is
 * configured. The ranking is still meaningful, so mock mode keeps its own,
 * lower gate; the corpus and the query are always embedded by the same
 * embedder, so the two scales never mix.
 */
export const MOCK_MIN_CITATION_SIMILARITY = 0.15;

/** The citation gate for whichever embedder produced the vectors being compared. */
export function minCitationSimilarity(embedderName: string): number {
  return embedderName === "mock" ? MOCK_MIN_CITATION_SIMILARITY : MIN_CITATION_SIMILARITY;
}
