import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDb>;
export type DatabaseClient = ReturnType<typeof drizzle<typeof schema>>;

let pooled: DatabaseClient | undefined;
let pooledSql: ReturnType<typeof postgres> | undefined;

/**
 * Runtime connection — goes through Supavisor (transaction mode, port 6543 in
 * the cloud; 54322 locally). `prepare: false` is required in transaction mode.
 */
export function createDb(connectionString: string, opts: { max?: number } = {}) {
  const client = postgres(connectionString, {
    prepare: false,
    max: opts.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return { db: drizzle(client, { schema, casing: "snake_case" }), sql: client };
}

export function getDb(): DatabaseClient {
  if (!pooled) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const created = createDb(url);
    pooled = created.db;
    pooledSql = created.sql;
  }
  return pooled;
}

export async function closeDb() {
  await pooledSql?.end();
  pooled = undefined;
  pooledSql = undefined;
}

export { schema };
