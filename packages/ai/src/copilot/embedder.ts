/**
 * Model-backed embedder on the Vercel AI SDK. The provider comes from
 * `../client` (AI Gateway → `openai/text-embedding-3-small`, or OpenAI direct
 * → `text-embedding-3-small`); with no key configured `selectEmbedder()` falls
 * back to the deterministic mock.
 *
 * Both routes are 1536-dimensional, which is what the pgvector column is
 * declared as — a model with any other width would silently corrupt search, so
 * `createEmbedder` refuses one whose vectors are the wrong size.
 */
import { embed, embedMany } from "ai";
import { embeddingModel } from "../client";
import { aiTimeoutSignal } from "../timeouts";
import { mockEmbedder } from "./mock-embedder";
import type { Embedder, EmbeddingResult } from "./types";

export const EMBEDDING_DIMENSIONS = 1536;

export function embedderAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return embeddingModel(env) !== null;
}

function assertDimensions(embedding: number[], id: string): number[] {
  if (embedding.length !== EMBEDDING_DIMENSIONS)
    throw new Error(
      `Embedding model ${id} returned ${embedding.length} dimensions; the corpus columns are ${EMBEDDING_DIMENSIONS}.`,
    );
  return embedding;
}

export function createEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder | null {
  const resolved = embeddingModel(env);
  if (!resolved) return null;
  const { model, id, label } = resolved;

  return {
    name: label,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(text: string): Promise<EmbeddingResult> {
      const result = await embed({ model, value: text, abortSignal: aiTimeoutSignal("embedding") });
      return { embedding: assertDimensions(result.embedding, id), model: id };
    },
    async embedMany(texts: string[]): Promise<EmbeddingResult[]> {
      const result = await embedMany({
        model,
        values: texts,
        abortSignal: aiTimeoutSignal("embedding"),
      });
      return result.embeddings.map((embedding) => ({
        embedding: assertDimensions(embedding, id),
        model: id,
      }));
    },
  };
}

/** .mock. inputs and CORRIDOR_EMBEDDER=mock force the deterministic embedder, mirroring extraction. */
export function selectEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder {
  if (env.CORRIDOR_EMBEDDER === "mock") return mockEmbedder;
  return createEmbedder(env) ?? mockEmbedder;
}
