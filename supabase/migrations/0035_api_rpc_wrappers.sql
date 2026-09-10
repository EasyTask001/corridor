-- 0032 narrowed PostgREST's exposed schemas to `api` and `graphql_public` and
-- revoked EXECUTE on every `public` function from anon/authenticated, but only
-- added `api` wrappers for the two SSO resolvers. Every other RPC the app calls
-- through supabase-js without an explicit `.schema("api")` — onboarding, invite
-- acceptance, permission resolution on every request, and the integration-vault
-- functions — has been unreachable ("Invalid schema: public") since that
-- migration landed. This adds the missing wrappers, following the same shape.

create or replace function api.create_organization_with_owner(
  p_name text,
  p_legal_name text default null,
  p_scac_code text default null,
  p_canadian_carrier_code text default null,
  p_us_dot_number text default null,
  p_mc_number text default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select public.create_organization_with_owner(
    p_name, p_legal_name, p_scac_code, p_canadian_carrier_code, p_us_dot_number, p_mc_number
  )
$$;

create or replace function api.accept_invitation(p_token text)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select public.accept_invitation(p_token)
$$;

create or replace function api.current_user_permissions(org_id uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_permissions(org_id)
$$;

create or replace function api.store_integration_secret(
  p_org uuid,
  p_provider text,
  p_secret text
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select public.store_integration_secret(p_org, p_provider, p_secret)
$$;

create or replace function api.delete_integration_secret(
  p_org uuid,
  p_provider text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select public.delete_integration_secret(p_org, p_provider)
$$;

-- read_integration_secret stays browser-unreachable: granted to service_role
-- only, same as the public-schema original (see 0012).
create or replace function api.read_integration_secret(
  p_org uuid,
  p_provider text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.read_integration_secret(p_org, p_provider)
$$;

grant usage on schema api to service_role;

revoke all on function api.create_organization_with_owner(text, text, text, text, text, text) from public;
revoke all on function api.accept_invitation(text) from public;
revoke all on function api.current_user_permissions(uuid) from public;
revoke all on function api.store_integration_secret(uuid, text, text) from public;
revoke all on function api.delete_integration_secret(uuid, text) from public;
revoke all on function api.read_integration_secret(uuid, text) from public;

grant execute on function api.create_organization_with_owner(text, text, text, text, text, text)
  to authenticated;
grant execute on function api.accept_invitation(text) to authenticated;
grant execute on function api.current_user_permissions(uuid) to authenticated;
grant execute on function api.store_integration_secret(uuid, text, text) to authenticated;
grant execute on function api.delete_integration_secret(uuid, text) to authenticated;
grant execute on function api.read_integration_secret(uuid, text) to service_role;
