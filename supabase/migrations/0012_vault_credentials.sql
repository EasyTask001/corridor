-- =============================================================================
-- Corridor — 0012 Supabase Vault for integration credentials
--
-- 0004 reserved `integration_configs.credentials_ref` for "a pointer into
-- Supabase Vault, never a raw secret" but nothing ever wrote it. This migration
-- makes that true:
--
--   store_integration_secret(org, provider, secret)  -> uuid   (authenticated)
--   delete_integration_secret(org, provider)         -> boolean(authenticated)
--   read_integration_secret(org, provider)           -> text   (service_role ONLY)
--
-- Writers are SECURITY DEFINER and re-check `integrations.manage` themselves,
-- because the definer runs as `postgres` and therefore bypasses RLS. The
-- reader is deliberately unreachable from a browser session: EXECUTE is
-- revoked from public/anon/authenticated so the plaintext can only be pulled
-- server-side by a service-role client (see services/customs.ts).
--
-- One vault secret per (organization, provider), named
--   integration:<org uuid>:<provider>
-- so a rotation updates the existing row rather than accumulating secrets.
-- A rotation MERGES into the stored JSON document (the UI sends only the fields
-- the operator retyped); wholesale replacement is delete + store.
-- =============================================================================

-- Supabase ships `supabase_vault` on every project (local and hosted); creating
-- it needs privileges a migration role does not have, so assert instead.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise exception
      'supabase_vault extension is required for integration credentials';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- store_integration_secret — create or rotate the credentials for one provider.
-- Returns the vault id (a pointer, not the secret) so callers can assert the
-- write landed. Never returns, logs or echoes the plaintext.
-- -----------------------------------------------------------------------------

create or replace function public.store_integration_secret(
  p_org uuid,
  p_provider text,
  p_secret text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text := 'integration:' || p_org::text || ':' || p_provider;
  v_ref   uuid;
  v_write text := p_secret;
  v_old   text;
  v_merge jsonb;
begin
  if not public.has_permission(p_org, 'integrations.manage') then
    raise exception 'not authorized for organization %', p_org using errcode = '42501';
  end if;
  if p_secret is null or length(p_secret) = 0 then
    raise exception 'integration secret must not be empty' using errcode = '22023';
  end if;

  select c.credentials_ref into v_ref
  from public.integration_configs c
  where c.organization_id = p_org and c.provider = p_provider;
  if not found then
    raise exception 'no integration config for organization % provider %', p_org, p_provider
      using errcode = 'P0002';
  end if;

  -- A ref pointing at a secret someone removed out of band is treated as absent.
  if v_ref is not null and not exists (select 1 from vault.secrets s where s.id = v_ref) then
    v_ref := null;
  end if;
  -- Adopt an orphaned secret with our name (vault.secrets.name is unique, so
  -- create_secret would otherwise fail forever after a partial write).
  if v_ref is null then
    select s.id into v_ref from vault.secrets s where s.name = v_name;
  end if;

  if v_ref is null then
    v_ref := vault.create_secret(p_secret, v_name, 'Corridor integration credentials');
  else
    -- A rotation carries only the fields the operator retyped, so merge rather
    -- than replace: keys present in the new document win, keys absent from it
    -- keep their stored value. Only the definer ever sees either plaintext —
    -- it stays inside this block and is never returned, raised or logged.
    -- Full replacement is delete_integration_secret followed by store.
    select s.decrypted_secret into v_old from vault.decrypted_secrets s where s.id = v_ref;
    if v_old is not null then
      begin
        if jsonb_typeof(v_old::jsonb) = 'object' and jsonb_typeof(p_secret::jsonb) = 'object' then
          -- an explicit null in the new document is "not supplied", not "erase"
          v_merge := coalesce(
            (select jsonb_object_agg(e.key, e.value)
             from jsonb_each(p_secret::jsonb) e
             where e.value <> 'null'::jsonb),
            '{}'::jsonb
          );
          v_write := (v_old::jsonb || v_merge)::text;
        end if;
      exception
        when invalid_text_representation then
          v_write := p_secret; -- not JSON on one side: replace wholesale
      end;
    end if;
    perform vault.update_secret(v_ref, v_write, v_name, 'Corridor integration credentials');
  end if;

  update public.integration_configs c
  set credentials_ref = v_ref
  where c.organization_id = p_org and c.provider = p_provider;

  return v_ref;
end;
$$;

-- -----------------------------------------------------------------------------
-- delete_integration_secret — mirrors store: same permission, same scoping.
-- Returns true when a secret was actually removed.
-- -----------------------------------------------------------------------------

create or replace function public.delete_integration_secret(
  p_org uuid,
  p_provider text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref uuid;
begin
  if not public.has_permission(p_org, 'integrations.manage') then
    raise exception 'not authorized for organization %', p_org using errcode = '42501';
  end if;

  select c.credentials_ref into v_ref
  from public.integration_configs c
  where c.organization_id = p_org and c.provider = p_provider;
  if v_ref is null then
    return false;
  end if;

  update public.integration_configs c
  set credentials_ref = null
  where c.organization_id = p_org and c.provider = p_provider;
  delete from vault.secrets s where s.id = v_ref;
  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- read_integration_secret — the ONLY path to the plaintext, and it is closed to
-- every browser-reachable role. Returns null when the org has no credentials.
-- -----------------------------------------------------------------------------

create or replace function public.read_integration_secret(
  p_org uuid,
  p_provider text
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select s.decrypted_secret into v_secret
  from public.integration_configs c
  join vault.decrypted_secrets s on s.id = c.credentials_ref
  where c.organization_id = p_org and c.provider = p_provider;
  return v_secret;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants. Supabase's default privileges hand EXECUTE on new public functions to
-- anon + authenticated, so the reader's revokes below are load-bearing.
-- -----------------------------------------------------------------------------

revoke execute on function public.store_integration_secret(uuid, text, text) from public, anon;
grant execute on function public.store_integration_secret(uuid, text, text)
  to authenticated, service_role;

revoke execute on function public.delete_integration_secret(uuid, text) from public, anon;
grant execute on function public.delete_integration_secret(uuid, text)
  to authenticated, service_role;

revoke execute on function public.read_integration_secret(uuid, text)
  from public, anon, authenticated;
grant execute on function public.read_integration_secret(uuid, text) to service_role;
