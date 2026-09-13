/**
 * Re-ingests only the copilot regulation corpus, without a full `pnpm db:seed`.
 * Safe to run repeatedly — ingestRegulations upserts by (source, title).
 *
 *   pnpm db:seed:regulations
 *
 * Requires: DIRECT_DATABASE_URL (provided by `supabase start` locally).
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import postgres from "postgres";
import { seedRegulationCorpus } from "./seed";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

export async function seedRegulations() {
  const sql = postgres(DB_URL, { max: 1 });
  try {
    await seedRegulationCorpus(sql);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  seedRegulations().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
