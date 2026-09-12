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

  it("every non-definer, non-trigger public function is executable by authenticated (0044)", async () => {
    // A SECURITY DEFINER function's nested calls run as its owner, and a
    // trigger fires regardless of EXECUTE on the trigger function itself
    // (Postgres invokes it via the trigger event, not a direct call) — so
    // neither needs an explicit authenticated grant. Everything else in this
    // schema is called BY NAME from a context running as `authenticated`
    // (a trigger body, a CHECK constraint, application code), and 0032's
    // blanket revoke silently breaks any such function 0037-and-successors
    // forgot to restore (issue #3: movement_can_transition, movement_is_editable,
    // sso_domains_valid all slipped through this way).
    const sql = postgres(url, { max: 1 });
    try {
      const rows = await sql<{ proname: string; args: string }[]>`
        select p.proname, pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prokind = 'f'
          and not p.prosecdef
          and pg_get_userbyid(p.proowner) = 'postgres'
          and not exists (select 1 from pg_trigger t where t.tgfoid = p.oid)
          and not has_function_privilege('authenticated', p.oid, 'execute')
        order by 1`;
      expect(rows).toEqual([]);
    } finally {
      await sql.end();
    }
  });

  it("every SECURITY DEFINER function documented as authenticated-reachable actually is (0044)", async () => {
    // docs/security-review.md §9b audits every SECURITY DEFINER function
    // granted to `authenticated` and confirms it re-checks the caller
    // internally (has_permission/auth.uid()/a token match) before doing
    // anything privileged. This is that table's own "Reachable by:
    // authenticated" column, made executable: SECURITY DEFINER changes what
    // happens *inside* a function, not whether authenticated may invoke it
    // at all — a missing EXECUTE grant (issue #3's 0032/0037 gap) silently
    // breaks the function for every caller regardless of the internal check.
    const documented = [
      "accept_invitation", "create_organization_with_owner", "current_user_permissions",
      "delete_integration_secret", "is_assigned_movement", "log_audit", "match_org_knowledge",
      "match_regulations", "next_movement_number", "notify_organization", "record_usage",
      "store_integration_secret",
    ];
    const sql = postgres(url, { max: 1 });
    try {
      const rows = await sql<{ proname: string }[]>`
        select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
          and p.proname = any(${documented}::text[])
          and not has_function_privilege('authenticated', p.oid, 'execute')`;
      expect(rows.map((r) => r.proname)).toEqual([]);
    } finally {
      await sql.end();
    }
  });

  it("the anon-reachable SSO lookup functions are directly anon-executable (0044)", async () => {
    // sso_provider_for_email/sso_enforced_for_email are documented in
    // docs/security-review.md §9b as "Reachable by: anon (by design)" — the
    // login page has no session yet. The api.* PostgREST wrappers stayed
    // anon-executable through 0032, but the underlying public.* functions
    // they call (and that packages/db/src/sso.integration.test.ts exercises
    // directly, matching how the design doc describes them) lost their own
    // anon grant in the same sweep and were never restored.
    const sql = postgres(url, { max: 1 });
    try {
      const rows = await sql<{ proname: string }[]>`
        select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('sso_provider_for_email', 'sso_enforced_for_email')
          and not has_function_privilege('anon', p.oid, 'execute')`;
      expect(rows.map((r) => r.proname)).toEqual([]);
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
