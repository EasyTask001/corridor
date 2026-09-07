/**
 * Model-backed embedder on the Vercel AI SDK. Uses OpenAI's
 * text-embedding-3-small (1536 dimensions — matches the pgvector column) when
 * OPENAI_API_KEY is set; otherwise selectEmbedder() falls back to the mock.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";
import { mockEmbedder } from "./mock-embedder";
import type { Embedder, EmbeddingResult } from "./types";

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

export function embedderAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.OPENAI_API_KEY;
}

export function createEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder | null {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const openai = createOpenAI({ apiKey });
  const id = env.CORRIDOR_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  const model = openai.textEmbeddingModel(id);

  return {
    name: `openai:${id}`,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(text: string): Promise<EmbeddingResult> {
      const result = await embed({ model, value: text });
      return { embedding: result.embedding, model: id };
    },
    async embedMany(texts: string[]): Promise<EmbeddingResult[]> {
      const result = await embedMany({ model, values: texts });
      return result.embeddings.map((embedding) => ({ embedding, model: id }));
    },
  };
}

/** .mock. inputs and CORRIDOR_EMBEDDER=mock force the deterministic embedder, mirroring extraction. */
export function selectEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder {
  if (env.CORRIDOR_EMBEDDER === "mock") return mockEmbedder;
  return createEmbedder(env) ?? mockEmbedder;
}
