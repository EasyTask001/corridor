-- =============================================================================
-- Corridor — 0018 port master + multi-carrier codes (Avaal parity gaps 7, 10)
--
--   1. public.ports — a global (non-tenant) lookup of CBP port-of-entry codes,
--      CBSA office codes, in-bond destinations, FIRMS codes and CBSA
--      sublocations, replacing the free-form `movements.crossing_point` jsonb
--      blob with validated, searchable, shared reference data.
--   2. public.organization_carrier_codes — the ACE/ACI carrier codes a tenant
--      files under. `organizations.scac_code` / `canadian_carrier_code` stay
--      as the onboarding inputs and seed one default row per regime; carriers
--      that file under more than one code (co-loaded fleets, brokered lanes)
--      add the rest here.
--   3. `movements` gains `port_id` (FK) and `carrier_code` (a snapshot, not an
--      FK — a movement's control number is built from the code at transmit
--      time and must never change retroactively if the org edits its codes
--      later) and drops `crossing_point`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. ports
--
-- Why a new table: the grain is a single customs code (a CBP port of entry, a
-- CBSA office, an in-bond destination, a FIRMS code, or a CBSA sublocation) —
-- shared reference data every tenant reads, not a tenant record. No existing
-- table fits: the registries (drivers/trucks/trailers/partners) are
-- organization-scoped, and `movements.crossing_point` was an unvalidated
-- `{code, name}` jsonb blob with no search index and no room for the other
-- four code kinds Avaal parity requires. A shared, non-tenant lookup table is
-- the natural fit.
-- -----------------------------------------------------------------------------

create table public.ports (
  id             uuid primary key default gen_random_uuid(),
  regime         text not null check (regime in ('ACE','ACI')),
  kind           text not null check (kind in
                   ('port_of_entry','in_bond_destination','cbsa_office','firms','sublocation')),
  code           text not null,
  name           text not null,
  state_province text,
  country        text not null check (country in ('US','CA')),
  -- sublocation -> its CBSA office; FIRMS code -> its port. Not a self-FK: a
  -- sublocation's parent may not have been imported yet when its row lands
  -- (the importer upserts all five CSVs independently), and the code, not the
  -- id, is the stable identifier CBSA/CBP publish.
  parent_code    text,
  active         boolean not null default true,
  unique (regime, kind, code)
);

create index ports_search_idx on public.ports
  using gin (to_tsvector('simple', code || ' ' || name));

alter table public.ports enable row level security;

-- Global catalogue: every signed-in (and unauthenticated, for public port
-- lookups embedded in marketing/onboarding) reader sees every active code.
create policy ports_select on public.ports for select to authenticated, anon
  using (active);

grant select on public.ports to authenticated, anon;
grant select, insert, update, delete on public.ports to service_role;
-- Supabase grants ALL on every table to anon/authenticated by default;
-- ports is written only by the importer (service_role, outside PostgREST).
revoke insert, update, delete on public.ports from authenticated, anon;

-- Seed the 12 crossing points the app already shipped (packages/domain
-- CROSSING_POINTS) inline, so `supabase db reset` alone leaves demo data
-- functional even before `pnpm db:seed` runs the full CSV importer.
insert into public.ports (regime, kind, code, name, state_province, country, active) values
  ('ACE', 'port_of_entry', '3801', 'Detroit — Ambassador Bridge, MI',    'MI', 'US', true),
  ('ACE', 'port_of_entry', '3802', 'Port Huron — Blue Water Bridge, MI', 'MI', 'US', true),
  ('ACE', 'port_of_entry', '0901', 'Buffalo — Peace Bridge, NY',         'NY', 'US', true),
  ('ACE', 'port_of_entry', '0712', 'Lewiston — Queenston Bridge, NY',    'NY', 'US', true),
  ('ACE', 'port_of_entry', '3004', 'Blaine — Pacific Highway, WA',       'WA', 'US', true),
  ('ACE', 'port_of_entry', '0209', 'Champlain — Rouses Point, NY',       'NY', 'US', true),
  ('ACI', 'cbsa_office',   '0453', 'Windsor — Ambassador Bridge, ON',    'ON', 'CA', true),
  ('ACI', 'cbsa_office',   '0440', 'Sarnia — Blue Water Bridge, ON',     'ON', 'CA', true),
  ('ACI', 'cbsa_office',   '0410', 'Fort Erie — Peace Bridge, ON',       'ON', 'CA', true),
  ('ACI', 'cbsa_office',   '0427', 'Queenston — Lewiston Bridge, ON',    'ON', 'CA', true),
  ('ACI', 'cbsa_office',   '0813', 'Pacific Highway, BC',                'BC', 'CA', true),
  ('ACI', 'cbsa_office',   '0351', 'Lacolle — Route 15, QC',             'QC', 'CA', true)
on conflict (regime, kind, code) do nothing;

-- -----------------------------------------------------------------------------
-- 2. organization_carrier_codes
--
-- Why a new table: the grain is one carrier identifier an organization files
-- customs manifests under, per regime — and a carrier may file under more than
-- one (a co-loaded fleet, or brokered lanes running under a partner's code).
-- `organizations.scac_code` / `canadian_carrier_code` are one-to-one columns
-- and can only ever hold a single default per regime; they stay as the
-- onboarding inputs (see create_organization_with_owner below) but cannot
-- express "PFTR is the default ACE code, PFTS is a second one this tenant also
-- files under". No existing table has that grain, so it gets its own.
-- -----------------------------------------------------------------------------

create table public.organization_carrier_codes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  regime          text not null check (regime in ('ACE','ACI')),
  code            text not null check (code ~ '^[A-Z0-9]{2,4}$'),
  label           text,
  is_default      boolean not null default false,
  status          text not null default 'active' check (status in ('active','inactive')),
  created_at      timestamptz not null default now(),
  unique (organization_id, regime, code)
);

create index organization_carrier_codes_org_idx on public.organization_carrier_codes (organization_id);

-- At most one default per organization + regime (partial unique index — a
-- plain `unique` can't express "unique only where true").
create unique index organization_carrier_codes_default_unique
  on public.organization_carrier_codes (organization_id, regime) where is_default;

alter table public.organization_carrier_codes enable row level security;

create policy organization_carrier_codes_select on public.organization_carrier_codes
  for select to authenticated
  using (public.has_permission(organization_id, 'organization.read'));

create policy organization_carrier_codes_insert on public.organization_carrier_codes
  for insert to authenticated
  with check (public.has_permission(organization_id, 'organization.manage'));

create policy organization_carrier_codes_update on public.organization_carrier_codes
  for update to authenticated
  using (public.has_permission(organization_id, 'organization.manage'))
  with check (public.has_permission(organization_id, 'organization.manage'));

create policy organization_carrier_codes_delete on public.organization_carrier_codes
  for delete to authenticated
  using (public.has_permission(organization_id, 'organization.manage'));

grant select, insert, update, delete on public.organization_carrier_codes to authenticated, service_role;

-- organizations.filer_code: the customs filer/broker identifier that appears
-- alongside the carrier code on a manifest. Same grain as scac_code /
-- canadian_carrier_code (one value per org) so it stays a column, not a row.
alter table public.organizations
  add column filer_code text check (filer_code ~ '^[A-Z0-9]{3}$');

-- Backfill: one default carrier-code row per regime for every org that
-- already carries a scac_code / canadian_carrier_code.
insert into public.organization_carrier_codes (organization_id, regime, code, is_default)
select id, 'ACE', scac_code, true from public.organizations
where scac_code is not null
on conflict (organization_id, regime, code) do nothing;

insert into public.organization_carrier_codes (organization_id, regime, code, is_default)
select id, 'ACI', canadian_carrier_code, true from public.organizations
where canadian_carrier_code is not null
on conflict (organization_id, regime, code) do nothing;

-- create_organization_with_owner now seeds the same default rows for a
-- freshly onboarded organization. Signature is unchanged — filer_code is not
-- an onboarding input, it's set later from organization settings.
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

  if p_scac_code is not null then
    insert into public.organization_carrier_codes (organization_id, regime, code, is_default)
    values (v_org_id, 'ACE', upper(p_scac_code), true);
  end if;
  if p_canadian_carrier_code is not null then
    insert into public.organization_carrier_codes (organization_id, regime, code, is_default)
    values (v_org_id, 'ACI', upper(p_canadian_carrier_code), true);
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, after)
  values (v_org_id, v_user_id, 'organization.create', 'organization', v_org_id::text,
          jsonb_build_object('name', p_name));

  return v_org_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. movements: crossing_point -> port_id + carrier_code
-- -----------------------------------------------------------------------------

alter table public.movements
  add column port_id      uuid references public.ports(id),
  add column carrier_code text;

-- Backfill from the jsonb code, matched within the movement's own regime (the
-- 12 seeded ports above are the only ones a pre-migration movement could
-- reference).
update public.movements m
set port_id = p.id
from public.ports p
where p.regime = m.regime
  and p.code = (m.crossing_point ->> 'code');

create index movements_port_idx on public.movements (port_id) where port_id is not null;

alter table public.movements drop column crossing_point;

-- movements_guard()'s frozen-column list (0003, revised 0011): crossing_point
-- -> port_id + carrier_code.
create or replace function public.movements_guard()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if not public.movement_can_transition(old.status, new.status) then
      raise exception 'invalid movement transition % -> %', old.status, new.status
        using errcode = 'P0001';
    end if;
    -- stamp lifecycle timestamps
    case new.status
      when 'sent'      then new.submitted_at := coalesce(new.submitted_at, now());
      when 'accepted'  then new.accepted_at  := now();
      when 'rejected'  then new.rejected_at  := now();
      when 'released'  then new.released_at  := now();
      when 'arrived'   then new.arrived_at   := now();
      when 'cancelled' then new.cancelled_at := now();
      else null;
    end case;
  else
    -- No status change: manifest content is frozen once transmitted.
    if not public.movement_is_editable(old.status) and (
         new.regime is distinct from old.regime
      or new.port_id is distinct from old.port_id
      or new.carrier_code is distinct from old.carrier_code
      or new.scheduled_crossing_at is distinct from old.scheduled_crossing_at
      or new.driver_id is distinct from old.driver_id
      or new.truck_id is distinct from old.truck_id
      or new.trailer_id is distinct from old.trailer_id
      or new.trip_number is distinct from old.trip_number
    ) then
      raise exception 'movement % is not editable in status %', old.movement_number, old.status
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
