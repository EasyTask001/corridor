-- =============================================================================
-- Corridor — 0001 core schema
-- Foundational multi-tenancy: organizations, members, roles, permissions.
-- RLS is the hard tenant boundary. Everything else layers on top of this.
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";
create extension if not exists "vector";

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- organizations
-- -----------------------------------------------------------------------------

create table public.organizations (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null check (char_length(name) between 1 and 120),
  legal_name            text,
  scac_code             text check (scac_code ~ '^[A-Z]{2,4}$'),
  canadian_carrier_code text check (canadian_carrier_code ~ '^[A-Z0-9]{4}$'),
  us_dot_number         text check (us_dot_number ~ '^\d{1,8}$'),
  mc_number             text,
  billing_email         citext,
  stripe_customer_id    text unique,
  subscription_plan     text not null default 'trial'
                          check (subscription_plan in ('trial','starter','professional','enterprise')),
  subscription_status   text not null default 'trialing'
                          check (subscription_status in ('trialing','active','past_due','canceled','incomplete')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- permissions (global catalogue; seeded from packages/domain PERMISSIONS)
-- -----------------------------------------------------------------------------

create table public.permissions (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  description text not null default '',
  module      text not null,
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- roles: organization_id NULL = system template usable by every org
-- -----------------------------------------------------------------------------

create table public.roles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 64),
  is_system       boolean not null default false,
  created_at      timestamptz not null default now(),
  constraint roles_system_has_no_org check (
    (is_system and organization_id is null) or (not is_system and organization_id is not null)
  )
);

create unique index roles_system_name_unique on public.roles (name) where organization_id is null;
create unique index roles_org_name_unique on public.roles (organization_id, name) where organization_id is not null;
create index roles_organization_id_idx on public.roles (organization_id);

create table public.role_permissions (
  role_id       uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

-- -----------------------------------------------------------------------------
-- organization_members
-- -----------------------------------------------------------------------------

create table public.organization_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid references auth.users(id) on delete cascade,
  role_id         uuid not null references public.roles(id) on delete restrict,
  status          text not null default 'invited' check (status in ('invited','active','suspended')),
  invited_email   citext,
  invite_token    text unique,
  invite_expires_at timestamptz,
  invited_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint members_active_requires_user check (status = 'invited' or user_id is not null),
  constraint members_invited_requires_email check (status <> 'invited' or invited_email is not null)
);

create unique index organization_members_org_user_unique
  on public.organization_members (organization_id, user_id) where user_id is not null;
create unique index organization_members_org_invite_email_unique
  on public.organization_members (organization_id, invited_email) where status = 'invited';
create index organization_members_user_id_idx on public.organization_members (user_id);
create index organization_members_organization_id_idx on public.organization_members (organization_id);

create trigger organization_members_set_updated_at
  before update on public.organization_members
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- user_profiles: display data for auth.users (auth schema is not queryable via RLS)
-- -----------------------------------------------------------------------------

create table public.user_profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger user_profiles_set_updated_at
  before update on public.user_profiles
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- -----------------------------------------------------------------------------
-- audit_log
-- -----------------------------------------------------------------------------

create table public.audit_log (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id        uuid references auth.users(id) on delete set null,
  action          text not null,
  entity_type     text not null,
  entity_id       text,
  before          jsonb,
  after           jsonb,
  created_at      timestamptz not null default now()
);

create index audit_log_org_created_idx on public.audit_log (organization_id, created_at desc);
create index audit_log_entity_idx on public.audit_log (organization_id, entity_type, entity_id);

-- -----------------------------------------------------------------------------
-- Tenant helper functions (STABLE + security definer so RLS policies don't
-- recurse into organization_members' own policy).
-- -----------------------------------------------------------------------------

create or replace function public.current_user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id
  from public.organization_members
  where user_id = (select auth.uid()) and status = 'active';
$$;

create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members
    where organization_id = org_id and user_id = (select auth.uid()) and status = 'active'
  );
$$;

create or replace function public.has_permission(org_id uuid, permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members m
    join public.role_permissions rp on rp.role_id = m.role_id
    join public.permissions p on p.id = rp.permission_id
    where m.organization_id = org_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and p.key = permission_key
  );
$$;

/** Permission keys for the calling user in an org — cached by the API layer. */
create or replace function public.current_user_permissions(org_id uuid)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select p.key
  from public.organization_members m
  join public.role_permissions rp on rp.role_id = m.role_id
  join public.permissions p on p.id = rp.permission_id
  where m.organization_id = org_id
    and m.user_id = (select auth.uid())
    and m.status = 'active';
$$;

-- -----------------------------------------------------------------------------
-- Onboarding RPC: create org + first Owner membership atomically.
-- Called by the signup flow; runs as the caller (SECURITY DEFINER to bypass the
-- chicken-and-egg RLS problem of inserting an org you're not yet a member of).
-- -----------------------------------------------------------------------------

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
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select id into v_owner_role_id from public.roles where is_system and name = 'Owner';
  if v_owner_role_id is null then
    raise exception 'system role Owner is not seeded';
  end if;

  insert into public.organizations (name, legal_name, scac_code, canadian_carrier_code, us_dot_number, mc_number)
  values (p_name, p_legal_name, upper(p_scac_code), upper(p_canadian_carrier_code), p_us_dot_number, p_mc_number)
  returning id into v_org_id;

  insert into public.organization_members (organization_id, user_id, role_id, status)
  values (v_org_id, v_user_id, v_owner_role_id, 'active');

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, after)
  values (v_org_id, v_user_id, 'organization.create', 'organization', v_org_id::text,
          jsonb_build_object('name', p_name));

  return v_org_id;
end;
$$;

-- Accept an invite: binds the invited row to the caller if the token matches.
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_user_email citext;
  v_member public.organization_members%rowtype;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select email into v_user_email from auth.users where id = v_user_id;

  select * into v_member
  from public.organization_members
  where invite_token = p_token and status = 'invited'
  for update;

  if v_member.id is null then
    raise exception 'invitation not found or already used' using errcode = 'P0002';
  end if;
  if v_member.invite_expires_at is not null and v_member.invite_expires_at < now() then
    raise exception 'invitation expired' using errcode = 'P0002';
  end if;
  if v_member.invited_email is distinct from v_user_email then
    raise exception 'invitation was issued to a different email address' using errcode = '42501';
  end if;

  update public.organization_members
  set user_id = v_user_id, status = 'active', invite_token = null, invite_expires_at = null
  where id = v_member.id;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id)
  values (v_member.organization_id, v_user_id, 'member.accept_invite', 'organization_member', v_member.id::text);

  return v_member.organization_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table public.organizations       enable row level security;
alter table public.permissions         enable row level security;
alter table public.roles               enable row level security;
alter table public.role_permissions    enable row level security;
alter table public.organization_members enable row level security;
alter table public.user_profiles       enable row level security;
alter table public.audit_log           enable row level security;

-- organizations: members read; owners/admins (organization.manage) update. No direct insert (use RPC).
create policy organizations_select on public.organizations
  for select to authenticated
  using (public.is_org_member(id));

create policy organizations_update on public.organizations
  for update to authenticated
  using (public.has_permission(id, 'organization.manage'))
  with check (public.has_permission(id, 'organization.manage'));

-- permissions: global read-only catalogue
create policy permissions_select on public.permissions
  for select to authenticated using (true);

-- roles: system roles visible to all; org roles visible to members; managed by organization.roles.manage
create policy roles_select on public.roles
  for select to authenticated
  using (organization_id is null or public.is_org_member(organization_id));

create policy roles_insert on public.roles
  for insert to authenticated
  with check (organization_id is not null and not is_system
              and public.has_permission(organization_id, 'organization.roles.manage'));

create policy roles_update on public.roles
  for update to authenticated
  using (organization_id is not null and not is_system
         and public.has_permission(organization_id, 'organization.roles.manage'))
  with check (organization_id is not null and not is_system
              and public.has_permission(organization_id, 'organization.roles.manage'));

create policy roles_delete on public.roles
  for delete to authenticated
  using (organization_id is not null and not is_system
         and public.has_permission(organization_id, 'organization.roles.manage'));

-- role_permissions: follow the role's visibility
create policy role_permissions_select on public.role_permissions
  for select to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id
                 and (r.organization_id is null or public.is_org_member(r.organization_id))));

create policy role_permissions_modify on public.role_permissions
  for all to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id and r.organization_id is not null
                 and public.has_permission(r.organization_id, 'organization.roles.manage')))
  with check (exists (select 1 from public.roles r where r.id = role_id and r.organization_id is not null
                      and public.has_permission(r.organization_id, 'organization.roles.manage')));

-- organization_members: members see their org's roster; managers invite/update/remove.
-- A user can always see their own membership rows (incl. invited) so they can accept.
create policy organization_members_select on public.organization_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_org_member(organization_id));

create policy organization_members_insert on public.organization_members
  for insert to authenticated
  with check (public.has_permission(organization_id, 'organization.members.manage'));

create policy organization_members_update on public.organization_members
  for update to authenticated
  using (public.has_permission(organization_id, 'organization.members.manage'))
  with check (public.has_permission(organization_id, 'organization.members.manage'));

create policy organization_members_delete on public.organization_members
  for delete to authenticated
  using (public.has_permission(organization_id, 'organization.members.manage'));

-- user_profiles: own row writable; visible to anyone sharing an org with you
create policy user_profiles_select on public.user_profiles
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.organization_members m
      where m.user_id = user_profiles.user_id and m.status = 'active'
        and public.is_org_member(m.organization_id)
    )
  );

create policy user_profiles_update on public.user_profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- audit_log: read with audit_log.read; writes happen via security-definer functions / service role
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (public.has_permission(organization_id, 'audit_log.read'));

-- -----------------------------------------------------------------------------
-- Grants (Supabase default roles)
-- -----------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
revoke insert, delete on public.organizations from authenticated;
revoke insert, update, delete on public.permissions from authenticated;
revoke insert, update, delete on public.audit_log from authenticated;
