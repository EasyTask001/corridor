/**
 * Test doubles for tRPC procedure unit tests: an in-memory fake of the Drizzle
 * transaction plus a `Context` carrying a session with the permissions and
 * plan a test chooses.
 *
 * The fake is deliberately a *shape* fake, not a database. It understands the
 * builder chains the routers use (`select().from().where()…`, `insert().values()
 * .returning()`, `update().set().where().returning()`, `delete().where()
 * .returning()`, `query.<table>.findFirst()`, `execute()`) and it projects
 * `select({ … })` field maps the way Drizzle does — but every predicate
 * (`where`, joins, `limit`, `orderBy`) is ignored. A test therefore controls
 * what a query returns by controlling what sits in that table's row array,
 * which keeps the tests about the procedure's own logic (guards, ordering of
 * writes, error mapping, audit) rather than about SQL.
 *
 * Aggregate selects — a field map whose values are all `sql` fragments, e.g.
 * `select({ next: sql\`max(line_number) + 1\` })` — cannot be evaluated, so
 * they resolve to one row built from `sqlValues`.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "@corridor/auth";
import type { PermissionKey, SubscriptionPlan } from "@corridor/domain";
import { schema, type RlsTransaction } from "@corridor/db";
import type { Context } from "../context";

export type Row = Record<string, unknown>;

const DRIZZLE_NAME = Symbol.for("drizzle:Name");
const DRIZZLE_COLUMNS = Symbol.for("drizzle:Columns");

type AnyTable = Record<string | symbol, unknown>;
type AnyColumn = { name: string; columnType: string; table: AnyTable };

function isTable(value: unknown): value is AnyTable {
  return (
    typeof value === "object" &&
    value !== null &&
    DRIZZLE_COLUMNS in (value as AnyTable) &&
    DRIZZLE_NAME in (value as AnyTable)
  );
}

function isColumn(value: unknown): value is AnyColumn {
  return (
    typeof value === "object" &&
    value !== null &&
    "columnType" in (value as Row) &&
    "table" in (value as Row)
  );
}

function tableName(table: AnyTable): string {
  return table[DRIZZLE_NAME] as string;
}

function columnsOf(table: AnyTable): Record<string, AnyColumn> {
  return table[DRIZZLE_COLUMNS] as Record<string, AnyColumn>;
}

/** The JS property name a column is exposed under (`organization_id` → `organizationId`). */
function jsKeyOf(column: AnyColumn): string {
  for (const [key, candidate] of Object.entries(columnsOf(column.table))) {
    if (candidate === column) return key;
  }
  return column.name;
}

/** DB table name → the key it has on the exported `schema` object. */
const SCHEMA_KEY_BY_TABLE = new Map<string, string>(
  Object.entries(schema).flatMap(([key, value]) =>
    isTable(value) ? [[tableName(value), key] as const] : [],
  ),
);

/**
 * Rows are stored under the table's `schema` key (`movementEvents`), not its DB
 * name, so a test seeds and asserts with the same names the routers use.
 */
function storeKey(table: AnyTable): string {
  const name = tableName(table);
  return SCHEMA_KEY_BY_TABLE.get(name) ?? name;
}

export interface FakeDbOptions {
  /** Seed rows, keyed by `schema` key — `{ movements: [...], movementEvents: [...] }`. */
  rows?: Record<string, Row[]>;
  /** Values for `sql` fragments in a projection, keyed by the projection field. */
  sqlValues?: Record<string, unknown>;
  /** Rows for a raw `tx.execute(sql\`…\`)`. Defaults to none. */
  onExecute?: (query: unknown) => unknown[];
  /**
   * Tables (by `schema` key) whose inserts hit a unique constraint: an
   * `onConflictDoNothing()` insert stores nothing and returns no rows, which is
   * how the routers detect "already exists".
   */
  insertConflicts?: string[];
  /**
   * Tables (by `schema` key) whose UPDATE hits a unique constraint — the value
   * is the `constraint_name` a real Postgres driver would report, so a test can
   * exercise `.catch(mapDbError)` the way `party.ts`/`organization.ts` use it.
   */
  updateConflicts?: Record<string, string>;
}

export interface FakeDb {
  /** Live row store — assert against it after a mutation. */
  rows: Record<string, Row[]>;
  /** Rows currently held for one table (empty array if it was never seeded). */
  table(name: string): Row[];
  /** Every statement handed to `tx.execute`, in order. */
  executed: unknown[];
  tx: RlsTransaction;
}

export function createFakeDb(options: FakeDbOptions = {}): FakeDb {
  const rows: Record<string, Row[]> = {};
  for (const [name, seed] of Object.entries(options.rows ?? {})) rows[name] = [...seed];
  const sqlValues = options.sqlValues ?? {};
  const insertConflicts = new Set(options.insertConflicts ?? []);
  const updateConflicts = options.updateConflicts ?? {};
  const executed: unknown[] = [];

  const table = (name: string): Row[] => (rows[name] ??= []);

  function project(source: Row[], fields?: Record<string, unknown>): Row[] {
    if (!fields) return source.map((row) => ({ ...row }));
    const entries = Object.entries(fields);
    if (entries.length > 0 && entries.every(([, value]) => !isColumn(value) && !isTable(value))) {
      // Pure aggregate/expression select — one row, from `sqlValues`.
      return [Object.fromEntries(entries.map(([key]) => [key, sqlValues[key]]))];
    }
    return source.map((row) => {
      const out: Row = {};
      for (const [key, value] of entries) {
        if (isTable(value)) out[key] = { ...row };
        else if (isColumn(value)) out[key] = row[jsKeyOf(value)];
        else out[key] = key in row ? row[key] : sqlValues[key];
      }
      return out;
    });
  }

  /** A chainable, awaitable stand-in for a Drizzle query builder. */
  function builder(resolve: () => Row[] | Promise<Row[]>) {
    const self: Record<string, unknown> = {};
    const passthrough = [
      "where",
      "from",
      "leftJoin",
      "innerJoin",
      "rightJoin",
      "fullJoin",
      "orderBy",
      "groupBy",
      "having",
      "limit",
      "offset",
      "for",
      "onConflictDoNothing",
      "$dynamic",
    ];
    for (const method of passthrough) self[method] = () => self;
    // `resolve` may throw synchronously (a simulated Postgres constraint
    // violation from `updateConflicts`) rather than reject — wrapping the call
    // in an `async` function turns that throw into a rejected promise, so
    // `.then`/`.catch`/`.finally` behave the same way a real (always-async)
    // query builder's would.
    const settle = async (): Promise<Row[]> => resolve();
    self.then = (onFulfilled?: (rows: Row[]) => unknown, onRejected?: (e: unknown) => unknown) =>
      settle().then(onFulfilled, onRejected);
    self.catch = (onRejected?: (e: unknown) => unknown) => settle().catch(onRejected);
    self.finally = (onFinally?: () => void) => settle().finally(onFinally);
    return self;
  }

  function selectBuilder(fields?: Record<string, unknown>) {
    let target: AnyTable | null = null;
    const self = builder(() => project(target ? table(storeKey(target)) : [], fields));
    self.from = (t: AnyTable) => {
      target = t;
      return self;
    };
    return self;
  }

  function insertBuilder(target: AnyTable) {
    const name = storeKey(target);
    const columns = columnsOf(target);
    let inserted: Row[] = [];
    let ignoreConflicts = false;
    const self: Record<string, unknown> = {};
    const materialise = () => {
      if (ignoreConflicts && insertConflicts.has(name)) return [];
      table(name).push(...inserted);
      return inserted;
    };
    const values = (input: Row | Row[]) => {
      inserted = (Array.isArray(input) ? input : [input]).map((value) => {
        const row: Row = { ...value };
        if ("id" in columns && row.id === undefined) row.id = randomUUID();
        for (const stamp of ["createdAt", "updatedAt"]) {
          if (stamp in columns && row[stamp] === undefined) row[stamp] = new Date();
        }
        return row;
      });
      return self;
    };
    self.values = values;
    self.onConflictDoNothing = () => {
      ignoreConflicts = true;
      return self;
    };
    self.onConflictDoUpdate = () => self;
    self.returning = (fields?: Record<string, unknown>) =>
      builder(() => project(materialise(), fields));
    self.then = (onFulfilled?: (rows: Row[]) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(materialise()).then(onFulfilled, onRejected);
    self.catch = (onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(materialise()).catch(onRejected);
    return self;
  }

  function updateBuilder(target: AnyTable) {
    const name = storeKey(target);
    let patch: Row = {};
    const apply = () => {
      const constraintName = updateConflicts[name];
      if (constraintName) {
        const err = new Error(
          `duplicate key value violates unique constraint "${constraintName}"`,
        ) as Error & { cause?: unknown };
        err.cause = { code: "23505", constraint_name: constraintName };
        throw err;
      }
      const updated = table(name);
      for (const row of updated) Object.assign(row, patch);
      return updated;
    };
    const self = builder(() => apply());
    self.set = (values: Row) => {
      patch = values;
      return self;
    };
    self.returning = (fields?: Record<string, unknown>) => builder(() => project(apply(), fields));
    return self;
  }

  function deleteBuilder(target: AnyTable) {
    const name = storeKey(target);
    const remove = () => {
      const removed = table(name);
      rows[name] = [];
      return removed;
    };
    const self = builder(() => remove());
    self.returning = (fields?: Record<string, unknown>) => builder(() => project(remove(), fields));
    return self;
  }

  const query = new Proxy(
    {},
    {
      get: (_t, key: string) => ({
        findFirst: () => Promise.resolve(table(key)[0] ?? undefined),
        findMany: () => Promise.resolve(table(key)),
      }),
    },
  );

  const tx = {
    query,
    select: (fields?: Record<string, unknown>) => selectBuilder(fields),
    selectDistinct: (fields?: Record<string, unknown>) => selectBuilder(fields),
    insert: (target: AnyTable) => insertBuilder(target),
    update: (target: AnyTable) => updateBuilder(target),
    delete: (target: AnyTable) => deleteBuilder(target),
    execute: (statement: unknown) => {
      executed.push(statement);
      return Promise.resolve(options.onExecute?.(statement) ?? []);
    },
  } as unknown as RlsTransaction;

  return { rows, table, executed, tx };
}

/**
 * Flatten a Drizzle `sql` statement into text with its parameters inlined, so a
 * test can assert which SECURITY DEFINER function a procedure called
 * (`record_usage`, `next_movement_number`, …) without matching on chunk shapes.
 */
export function statementText(statement: unknown): string {
  const chunks = (statement as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "object" && chunk !== null && "value" in chunk) {
        const value = chunk.value;
        return Array.isArray(value) ? value.join("") : String(value);
      }
      return String(chunk);
    })
    .join("");
}

export const TEST_ORG_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_USER_ID = "22222222-2222-4222-8222-222222222222";

export interface MockContextOptions extends FakeDbOptions {
  /** Permission keys the caller holds. Defaults to none. */
  permissions?: PermissionKey[];
  plan?: SubscriptionPlan;
  orgId?: string;
  userId?: string;
  email?: string;
  /** Drop the active organization (to exercise the `orgProcedure` guard). */
  withoutOrg?: boolean;
  supabase?: Partial<SupabaseClient>;
  /** Called when an `ctx.rls(...)` callback resolves — i.e. at "commit". */
  onCommit?: () => void;
}

export function createTestSession(options: MockContextOptions = {}): Session {
  const orgId = options.orgId ?? TEST_ORG_ID;
  return {
    user: {
      id: options.userId ?? TEST_USER_ID,
      email: options.email ?? "dispatch@corridor.test",
      displayName: "Test Dispatcher",
    },
    memberships: [
      {
        organizationId: orgId,
        organizationName: "Corridor Test Carrier",
        roleId: "33333333-3333-4333-8333-333333333333",
        roleName: "Dispatcher",
        status: "active",
      },
    ],
    activeOrganizationId: options.withoutOrg ? null : orgId,
    plan: options.plan ?? "professional",
    permissions: new Set(options.permissions ?? []),
    accessToken: "test-access-token",
  };
}

export interface MockContext {
  ctx: Context;
  db: FakeDb;
  session: Session;
  orgId: string;
}

export function createMockContext(options: MockContextOptions = {}): MockContext {
  const session = createTestSession(options);
  const db = createFakeDb(options);
  const ctx: Context = {
    session,
    supabase: (options.supabase ?? {}) as SupabaseClient,
    db: {} as Context["db"],
    headers: new Headers(),
    // Modelled as a real transaction boundary: `onCommit` fires when the
    // callback resolves, which is what lets a test assert that post-commit work
    // (notification delivery, cache invalidation) really happens afterwards.
    rls: async (fn) => {
      const result = await fn(db.tx);
      options.onCommit?.();
      return result;
    },
  };
  return { ctx, db, session, orgId: options.orgId ?? TEST_ORG_ID };
}

/**
 * Build a caller over a mock context, returning the fake DB and session
 * alongside it so a test can assert on what was written. Takes the *factory*
 * (`createCallerFactory(someRouter)`) rather than the router, so the caller
 * keeps the router's exact procedure types.
 */
export function createMockCaller<TCaller>(
  createCaller: (ctx: Context) => TCaller,
  options: MockContextOptions = {},
): MockContext & { caller: TCaller } {
  const mock = createMockContext(options);
  return { ...mock, caller: createCaller(mock.ctx) };
}
