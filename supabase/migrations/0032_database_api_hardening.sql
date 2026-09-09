-- Keep PostgREST focused on explicitly reviewed API functions.  Business tables
-- remain available to the database role and are accessed by the application
-- through its RLS transaction layer.
create schema if not exists api;
revoke all on schema api from public;
grant usage on schema api to anon, authenticated;

create or replace function api.sso_provider_for_email(p_email text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.sso_provider_for_email(p_email::public.citext)
$$;

create or replace function api.sso_enforced_for_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.sso_enforced_for_email(p_email::public.citext)
$$;

revoke all on function api.sso_provider_for_email(text) from public;
revoke all on function api.sso_enforced_for_email(text) from public;
grant execute on function api.sso_provider_for_email(text) to anon, authenticated;
grant execute on function api.sso_enforced_for_email(text) to anon, authenticated;

-- SECURITY DEFINER routines must never inherit a caller-controlled search path.
-- Existing bodies use schema-qualified application relations, so an empty path
-- is safe and makes future unqualified lookup fail closed.
do $$
declare
  r record;
begin
  for r in
    select n.nspname as schema_name, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef
      and n.nspname = 'public'
  loop
    execute format('alter function %I.%I(%s) set search_path = ''''', r.schema_name, r.proname, r.args);
  end loop;
end;
$$;

-- No application role should be able to execute arbitrary public functions.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.match_regulations(vector, int, text) to authenticated, service_role;
grant execute on function public.match_org_knowledge(uuid, vector, int) to authenticated, service_role;
grant execute on function public.sso_email_domain(public.citext) to anon, authenticated, service_role;
grant execute on function public.sso_provider_for_email(public.citext) to service_role;
grant execute on function public.sso_enforced_for_email(public.citext) to service_role;
