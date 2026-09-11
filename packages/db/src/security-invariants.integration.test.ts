import postgres from "postgres";
import { describe, expect, it } from "vitest";

const url = process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

describe("database API security invariants", () => {
  it("exposes only the allowlisted anonymous API functions", async () => {
    const sql = postgres(url, { max: 1 });
    try {
      const rows = await sql<{ schema_name: string; function_name: string }[]>`
        select n.nspname as schema_name, p.proname as function_name
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where p.prokind = 'f'
          and has_function_privilege('anon', p.oid, 'execute')
          and n.nspname in ('public', 'api')
          and (n.nspname = 'api' or pg_get_userbyid(p.proowner) = 'postgres')
          and n.nspname = 'api'
        order by 1, 2`;
      expect(rows.map((r) => `${r.schema_name}.${r.function_name}`)).toEqual([
        "api.sso_enforced_for_email",
        "api.sso_provider_for_email",
      ]);

      const unsafeDefiners = await sql<{ count: string }[]>`
        select count(*)::text as count
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname = 'public'
          and pg_get_userbyid(p.proowner) = 'postgres'
          and exists (
            select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
            where cfg like 'search_path=%' and cfg <> 'search_path=""'
          )`;
      expect(Number(unsafeDefiners[0]?.count ?? 0)).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it("every FK to ports and every ILIKE search column is indexed (0043)", async () => {
    const sql = postgres(url, { max: 1 });
    try {
      const rows = await sql<{ indexname: string }[]>`
        select indexname from pg_indexes where schemaname = 'public' and indexname = any(${[
          "shipments_entry_port_idx", "shipments_in_bond_destination_port_idx", "shipments_destination_port_idx",
          "shipments_sublocation_port_idx", "in_bond_records_arrival_port_idx", "in_bond_records_export_port_idx",
          "movements_trip_number_trgm_idx", "movements_customs_reference_trgm_idx",
          "drivers_full_name_trgm_idx", "trucks_unit_number_trgm_idx",
        ]}::text[])`;
      expect(rows.map((r) => r.indexname).sort()).toHaveLength(10);
    } finally {
      await sql.end();
    }
  });
});
