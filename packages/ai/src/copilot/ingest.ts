/**
 * Ingestion pipeline: chunk each regulation, embed the chunks, and upsert
 * regulation_documents + regulation_embeddings. Idempotent — re-running with
 * the same corpus updates existing rows instead of duplicating them, so it's
 * safe to call from `pnpm db:seed`.
 *
 * DB access is via a plain callback the caller provides (no direct Postgres
 * dependency in packages/ai — matches the rest of the package staying
 * transport-agnostic; packages/db/scripts/seed.ts and packages/api's admin
 * tooling both call this with their own connection).
 */
import { chunkText } from "./chunk";
import { REGULATION_CORPUS, type RegulationSeed } from "./regulations-corpus";
import { selectEmbedder } from "./embedder";
import type { Embedder } from "./types";

export interface IngestSink {
  /** Insert or update a regulation_documents row by (source, title); return its id. */
  upsertDocument(doc: Omit<RegulationSeed, "content"> & { content: string }): Promise<string>;
  /** Replace all embeddings for a document with the given chunks. */
  replaceEmbeddings(
    documentId: string,
    chunks: Array<{ chunkIndex: number; content: string; embedding: number[] }>,
  ): Promise<void>;
}

export interface IngestResult {
  documents: number;
  chunks: number;
  embedder: string;
}

export async function ingestRegulations(
  sink: IngestSink,
  opts: { corpus?: RegulationSeed[]; embedder?: Embedder } = {},
): Promise<IngestResult> {
  const corpus = opts.corpus ?? REGULATION_CORPUS;
  const embedder = opts.embedder ?? selectEmbedder();

  let chunkCount = 0;
  for (const reg of corpus) {
    const documentId = await sink.upsertDocument(reg);
    const chunks = chunkText(reg.content);
    const embeddings = await embedder.embedMany(chunks);
    await sink.replaceEmbeddings(
      documentId,
      chunks.map((content, i) => ({ chunkIndex: i, content, embedding: embeddings[i]!.embedding })),
    );
    chunkCount += chunks.length;
  }

  return { documents: corpus.length, chunks: chunkCount, embedder: embedder.name };
}
