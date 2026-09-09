import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

const conn = createDb(DB_URL, { max: 1 });
const db = conn.db;

afterAll(async () => {
  await conn.sql.end();
});

describe("tenant referential integrity", () => {
  it("requires organization-owned foreign keys to constrain both IDs", async () => {
    const rows = await db.execute<{ unsafe_count: number }>(sql`
      with tenant_tables as (
        select c.oid
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and exists (
            select 1
            from pg_attribute a
            where a.attrelid = c.oid
              and a.attname = 'organization_id'
              and not a.attisdropped
          )
      )
      select count(*)::int as unsafe_count
      from pg_constraint fk
      join tenant_tables child on child.oid = fk.conrelid
      join tenant_tables parent on parent.oid = fk.confrelid
      join pg_attribute child_org
        on child_org.attrelid = fk.conrelid
       and child_org.attname = 'organization_id'
      join pg_attribute parent_org
        on parent_org.attrelid = fk.confrelid
       and parent_org.attname = 'organization_id'
      where fk.contype = 'f'
        and not (
          child_org.attnum = any(fk.conkey)
          and parent_org.attnum = any(fk.confkey)
        )
    `);

    expect(Number(rows[0]?.unsafe_count ?? 0)).toBe(0);
  });
});
