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
