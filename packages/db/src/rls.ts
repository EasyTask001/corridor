import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { DatabaseClient } from "./client";
import type * as schema from "./schema";

export type RlsTransaction = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export interface RlsClaims {
  /** auth.users.id */
  sub: string;
  email?: string;
  role?: "authenticated";
  [k: string]: unknown;
}

/**
 * Runs `fn` inside a transaction with the Postgres role switched to
 * `authenticated` and `request.jwt.claims` set, so every Drizzle query in the
 * callback is subject to Supabase RLS exactly as if it came through PostgREST.
 *
 * Supabase's documented Drizzle + RLS pattern. `SET LOCAL` and the `true`
 * (is_local) flag on `set_config` scope everything to this transaction, so the
 * role and claims are automatically reverted on COMMIT *and* ROLLBACK — safe
 * for Supavisor, which reuses connections across tenants. (An explicit
 * `reset role` in a `finally` would itself fail inside an aborted transaction
 * and mask the real RLS error.)
 */
export async function withRls<T>(
  db: DatabaseClient,
  claims: RlsClaims,
  fn: (tx: RlsTransaction) => Promise<T>,
): Promise<T> {
  const jwt = JSON.stringify({ role: "authenticated", ...claims });
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select set_config('request.jwt.claims', ${jwt}, true),
             set_config('request.jwt.claim.sub', ${claims.sub}, true),
             set_config('request.jwt.claim.role', 'authenticated', true)
    `);
    await tx.execute(sql`set local role authenticated`);
    return fn(tx);
  });
}

/**
 * Service-role transaction: bypasses RLS (runs as the connection's own role).
 * Callers MUST filter by organization_id explicitly; cross-tenant-leak tests
 * cover every such path.
 *
 * NEVER call this from inside a `withRls` callback (or any other open
 * transaction on the same pool). It takes a SECOND connection while the first
 * is still held, so under load every outer transaction ends up waiting for an
 * inner connection that no one can get and the pool deadlocks against itself.
 * Work that needs the service role while a user transaction is open must
 * either run after that transaction resolves, or be enqueued as a background
 * job for the worker to pick up.
 */
export async function withServiceRole<T>(
  db: DatabaseClient,
  fn: (tx: RlsTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction((tx) => fn(tx));
}
