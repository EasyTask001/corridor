-- Ensure onboarding creates a tenant-scoped Owner role. System roles cannot be
-- referenced by organization_members because membership validates the
-- (role_id, organization_id) pair.
create or replace function public.create_organization_with_owner(
  p_name text,
  p_legal_name text default null,
  p_scac_code text default null,
  p_canadian_carrier_code text default null,
  p_us_dot_number text default null,
  p_mc_number text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_owner_role_id uuid;
  v_system_owner_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- Imported or pre-provisioned owners may already have a membership but no
  -- active-org cookie. Reuse that organization instead of creating a duplicate.
  select organization_id into v_org_id
    from organization_members
    where user_id = v_user_id and status = 'active'
    order by created_at
    limit 1;
  if v_org_id is not null then return v_org_id; end if;
  insert into organizations (name, legal_name, scac_code, canadian_carrier_code, us_dot_number, mc_number)
    values (p_name, p_legal_name, upper(p_scac_code), upper(p_canadian_carrier_code), p_us_dot_number, p_mc_number)
    returning id into v_org_id;
  select id into v_system_owner_id from roles where is_system and name = 'Owner';
  if v_system_owner_id is null then raise exception 'system role Owner is not seeded'; end if;
  insert into roles (organization_id, name, is_system)
    values (v_org_id, 'Owner', false) returning id into v_owner_role_id;
  insert into role_permissions (role_id, permission_id)
    select v_owner_role_id, permission_id from role_permissions where role_id = v_system_owner_id;
  insert into organization_members (organization_id, user_id, role_id, status)
    values (v_org_id, v_user_id, v_owner_role_id, 'active');
  insert into audit_log (organization_id, actor_id, action, entity_type, entity_id, after)
    values (v_org_id, v_user_id, 'organization.create', 'organization', v_org_id::text,
            jsonb_build_object('name', p_name));
  return v_org_id;
end;
$$;
