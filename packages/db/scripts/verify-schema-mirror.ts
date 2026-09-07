/**
 * Verifies the claim at the top of src/schema/index.ts: the Drizzle mirror
 * matches the SQL migrations column-for-column and index-for-index.
 *
 *   pnpm --filter @corridor/db verify:mirror
 *
 * Run it against a database that has every migration applied (`pnpm db:reset`).
 * Every Drizzle table must exist with the same columns (type + nullability, no
 * extras on either side), and every declared index must exist with the same key
 * columns in the same order and the same sort direction.
 */
import postgres from "postgres";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/schema/index";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

/** Postgres reports these under a different name than Drizzle's getSQLType(). */
const TYPE_ALIASES: Record<string, string> = {
  timestamp: "timestamptz",
  bigint: "int8",
  integer: "int4",
  smallint: "int2",
  boolean: "bool",
};

const normaliseType = (t: string) => {
  const base = t
    .toLowerCase()
    .replace(" with time zone", "")
    .replace(/\(.*\)/, "")
    .trim();
  return TYPE_ALIASES[base] ?? base;
};

export async function verifySchemaMirror(url = DB_URL) {
  const sql = postgres(url, { max: 1 });
  const problems: string[] = [];
  try {
    // indoption bit 0 carries DESC; attname is null for expression keys.
    const indexRows = await sql<
      { index_name: string; column_name: string | null; ord: number; is_desc: boolean }[]
    >`
      select i.relname as index_name, a.attname as column_name, k.ord::int as ord,
             (x.indoption[k.ord - 1] & 1) = 1 as is_desc
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
      cross join lateral unnest(x.indkey) with ordinality as k(attnum, ord)
      left join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.attnum
      order by i.relname, k.ord`;
    const dbIndexes = new Map<string, string[]>();
    for (const r of indexRows) {
      const key = `${r.column_name ?? "(expr)"}:${r.is_desc ? "desc" : "asc"}`;
      dbIndexes.set(r.index_name, [...(dbIndexes.get(r.index_name) ?? []), key]);
    }

    const columnRows = await sql<
      { table_name: string; column_name: string; data_type: string; is_nullable: string }[]
    >`
      select c.table_name, c.column_name, c.udt_name as data_type, c.is_nullable
      from information_schema.columns c
      join pg_tables t on t.tablename = c.table_name and t.schemaname = 'public'
      where c.table_schema = 'public'`;
    const dbColumns = new Map<string, Map<string, { type: string; notNull: boolean }>>();
    for (const r of columnRows) {
      if (!dbColumns.has(r.table_name)) dbColumns.set(r.table_name, new Map());
      dbColumns
        .get(r.table_name)!
        .set(r.column_name, { type: r.data_type, notNull: r.is_nullable === "NO" });
    }

    let tables = 0;
    let indexes = 0;
    for (const value of Object.values(schema)) {
      let table;
      try {
        table = getTableConfig(value as PgTable);
      } catch {
        continue; // not a table (enums, helpers, constants)
      }
      if (table.schema && table.schema !== "public") continue;
      tables++;

      const columns = dbColumns.get(table.name);
      if (!columns) {
        problems.push(`table ${table.name}: missing from the database`);
        continue;
      }
      for (const column of table.columns) {
        const actual = columns.get(column.name);
        if (!actual) {
          problems.push(`${table.name}.${column.name}: missing from the database`);
          continue;
        }
        // information_schema prefixes array element types with an underscore.
        const actualType = actual.type.startsWith("_") ? actual.type.slice(1) : actual.type;
        const expectedType = normaliseType(column.getSQLType()).replace("[]", "");
        if (expectedType !== actualType) {
          problems.push(
            `${table.name}.${column.name}: Drizzle ${expectedType} vs DB ${actualType}`,
          );
        }
        if (column.notNull !== actual.notNull) {
          problems.push(
            `${table.name}.${column.name}: notNull Drizzle=${column.notNull} DB=${actual.notNull}`,
          );
        }
        columns.delete(column.name);
      }
      for (const extra of columns.keys()) {
        problems.push(`${table.name}.${extra}: missing from the Drizzle mirror`);
      }

      for (const index of table.indexes) {
        indexes++;
        const name = index.config.name!;
        const actual = dbIndexes.get(name);
        if (!actual) {
          problems.push(`index ${name}: missing from the database`);
          continue;
        }
        const expected = index.config.columns.map((c) => {
          const col = c as { name?: string; indexConfig?: { order?: "asc" | "desc" } };
          return `${col.name ?? "(expr)"}:${col.indexConfig?.order ?? "asc"}`;
        });
        if (expected.join(", ") !== actual.join(", ")) {
          problems.push(`index ${name}: Drizzle [${expected}] vs DB [${actual}]`);
        }
      }
    }
    return { tables, indexes, problems };
  } finally {
    await sql.end();
  }
}

verifySchemaMirror()
  .then(({ tables, indexes, problems }) => {
    console.log(`checked ${tables} tables and ${indexes} declared indexes`);
    if (problems.length === 0) {
      console.log("no drift");
      return;
    }
    for (const p of problems) console.error(`  DRIFT: ${p}`);
    process.exit(1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
