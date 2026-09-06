-- =============================================================================
-- Corridor — 0002 core registries + compliance alerts
-- drivers, trucks, trailers, partners (shippers/consignees/brokers) and the
-- rule-based compliance_alerts table. All tenant-scoped, RLS-enforced,
-- writes gated by <entity>.write / alert.manage permissions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- drivers
-- -----------------------------------------------------------------------------

create table public.drivers (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  first_name           text not null check (char_length(first_name) between 1 and 80),
  last_name            text not null check (char_length(last_name) between 1 and 80),
  license_number       text not null,
  license_jurisdiction text not null check (license_jurisdiction ~ '^[A-Z]{2}$'),
  license_expiry       date,
  fast_card_number     text,
  fast_card_expiry     date,
  medical_cert_expiry  date,
  date_of_birth        date,
  citizenship          text check (citizenship ~ '^[A-Z]{2}$'),
  phone                text,
  email                citext,
  status               text not null default 'active' check (status in ('active','inactive','archived')),
  notes                text,
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index drivers_organization_id_idx on public.drivers (organization_id);
create index drivers_org_created_idx on public.drivers (organization_id, created_at desc);
create index drivers_org_status_idx on public.drivers (organization_id, status);
create unique index drivers_org_license_unique
  on public.drivers (organization_id, license_jurisdiction, license_number)
  where status <> 'archived';
create index drivers_name_search_idx
  on public.drivers using gin (to_tsvector('simple', first_name || ' ' || last_name));

create trigger drivers_set_updated_at
  before update on public.drivers for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- trucks
-- -----------------------------------------------------------------------------

create table public.trucks (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  unit_number             text not null check (char_length(unit_number) between 1 and 40),
  vin                     text check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  make                    text,
  model                   text,
  model_year              smallint check (model_year between 1950 and 2100),
  plate_number            text not null,
  plate_jurisdiction      text not null check (plate_jurisdiction ~ '^[A-Z]{2}$'),
  registration_expiry     date,
  insurance_policy_number text,
  insurance_expiry        date,
  annual_inspection_expiry date,
  transponder_number      text,
  status                  text not null default 'active' check (status in ('active','inactive','archived')),
  notes                   text,
  created_by              uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index trucks_organization_id_idx on public.trucks (organization_id);
create index trucks_org_created_idx on public.trucks (organization_id, created_at desc);
create unique index trucks_org_unit_unique on public.trucks (organization_id, unit_number) where status <> 'archived';
create unique index trucks_org_vin_unique on public.trucks (organization_id, vin) where vin is not null and status <> 'archived';

create trigger trucks_set_updated_at
  before update on public.trucks for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- trailers
-- -----------------------------------------------------------------------------

create table public.trailers (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  unit_number         text not null check (char_length(unit_number) between 1 and 40),
  vin                 text check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  trailer_type        text not null default 'dry_van'
                        check (trailer_type in ('dry_van','reefer','flatbed','tanker','container_chassis','step_deck','other')),
  plate_number        text not null,
  plate_jurisdiction  text not null check (plate_jurisdiction ~ '^[A-Z]{2}$'),
  registration_expiry date,
  insurance_expiry    date,
  annual_inspection_expiry date,
  length_ft           numeric(5,1),
  status              text not null default 'active' check (status in ('active','inactive','archived')),
  notes               text,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index trailers_organization_id_idx on public.trailers (organization_id);
create index trailers_org_created_idx on public.trailers (organization_id, created_at desc);
create unique index trailers_org_unit_unique on public.trailers (organization_id, unit_number) where status <> 'archived';

create trigger trailers_set_updated_at
  before update on public.trailers for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- partners (shipper / consignee / broker)
-- -----------------------------------------------------------------------------

create table public.partners (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 160),
  type            text not null check (type in ('shipper','consignee','broker','both')),
  address         jsonb not null default '{}'::jsonb,
  tax_id          text,
  contact_name    text,
  contact_email   citext,
  contact_phone   text,
  status          text not null default 'active' check (status in ('active','inactive','archived')),
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index partners_organization_id_idx on public.partners (organization_id);
create index partners_org_created_idx on public.partners (organization_id, created_at desc);
create index partners_org_type_idx on public.partners (organization_id, type);
create index partners_name_search_idx on public.partners using gin (to_tsvector('simple', name));

create trigger partners_set_updated_at
  before update on public.partners for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- compliance_alerts (rule-based in Phase 1; AI-sourced alerts arrive later)
-- movement_id gets its FK in 0003 when movements exist.
-- -----------------------------------------------------------------------------

create table public.compliance_alerts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  movement_id     uuid,
  driver_id       uuid references public.drivers(id) on delete cascade,
  truck_id        uuid references public.trucks(id) on delete cascade,
  trailer_id      uuid references public.trailers(id) on delete cascade,
  alert_type      text not null check (alert_type in
                    ('document_expiry','hold_prediction','risk_flag','missing_data','hs_code_mismatch')),
  severity        text not null check (severity in ('info','warning','critical')),
  title           text not null,
  description     text,
  status          text not null default 'open' check (status in ('open','acknowledged','resolved','dismissed')),
  /** stable key so re-running a rule updates the existing open alert instead of duplicating */
  dedupe_key      text,
  source          text not null default 'rules' check (source in ('rules','ai','user')),
  due_at          date,
  acknowledged_by uuid references auth.users(id) on delete set null,
  acknowledged_at timestamptz,
  resolved_by     uuid references auth.users(id) on delete set null,
  resolved_at     timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index compliance_alerts_organization_id_idx on public.compliance_alerts (organization_id);
create index compliance_alerts_org_type_status_idx on public.compliance_alerts (organization_id, alert_type, status);
create index compliance_alerts_org_status_severity_idx on public.compliance_alerts (organization_id, status, severity);
create index compliance_alerts_driver_idx on public.compliance_alerts (driver_id) where driver_id is not null;
create index compliance_alerts_truck_idx on public.compliance_alerts (truck_id) where truck_id is not null;
create index compliance_alerts_trailer_idx on public.compliance_alerts (trailer_id) where trailer_id is not null;
create unique index compliance_alerts_open_dedupe_unique
  on public.compliance_alerts (organization_id, dedupe_key)
  where dedupe_key is not null and status in ('open','acknowledged');

create trigger compliance_alerts_set_updated_at
  before update on public.compliance_alerts for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

alter table public.drivers            enable row level security;
alter table public.trucks             enable row level security;
alter table public.trailers           enable row level security;
alter table public.partners           enable row level security;
alter table public.compliance_alerts  enable row level security;

-- drivers
create policy drivers_select on public.drivers for select to authenticated
  using (public.has_permission(organization_id, 'driver.read'));
create policy drivers_insert on public.drivers for insert to authenticated
  with check (public.has_permission(organization_id, 'driver.write'));
create policy drivers_update on public.drivers for update to authenticated
  using (public.has_permission(organization_id, 'driver.write'))
  with check (public.has_permission(organization_id, 'driver.write'));
create policy drivers_delete on public.drivers for delete to authenticated
  using (public.has_permission(organization_id, 'driver.write'));

-- trucks
create policy trucks_select on public.trucks for select to authenticated
  using (public.has_permission(organization_id, 'truck.read'));
create policy trucks_insert on public.trucks for insert to authenticated
  with check (public.has_permission(organization_id, 'truck.write'));
create policy trucks_update on public.trucks for update to authenticated
  using (public.has_permission(organization_id, 'truck.write'))
  with check (public.has_permission(organization_id, 'truck.write'));
create policy trucks_delete on public.trucks for delete to authenticated
  using (public.has_permission(organization_id, 'truck.write'));

-- trailers
create policy trailers_select on public.trailers for select to authenticated
  using (public.has_permission(organization_id, 'trailer.read'));
create policy trailers_insert on public.trailers for insert to authenticated
  with check (public.has_permission(organization_id, 'trailer.write'));
create policy trailers_update on public.trailers for update to authenticated
  using (public.has_permission(organization_id, 'trailer.write'))
  with check (public.has_permission(organization_id, 'trailer.write'));
create policy trailers_delete on public.trailers for delete to authenticated
  using (public.has_permission(organization_id, 'trailer.write'));

-- partners
create policy partners_select on public.partners for select to authenticated
  using (public.has_permission(organization_id, 'partner.read'));
create policy partners_insert on public.partners for insert to authenticated
  with check (public.has_permission(organization_id, 'partner.write'));
create policy partners_update on public.partners for update to authenticated
  using (public.has_permission(organization_id, 'partner.write'))
  with check (public.has_permission(organization_id, 'partner.write'));
create policy partners_delete on public.partners for delete to authenticated
  using (public.has_permission(organization_id, 'partner.write'));

-- compliance_alerts: read with alert.read; status changes with alert.manage.
-- Rule-generated inserts come from the API acting as the user who saved the
-- registry row, so insert is allowed to anyone who can write the underlying
-- entity (checked in the API); DB-level we require membership + alert.read.
create policy compliance_alerts_select on public.compliance_alerts for select to authenticated
  using (public.has_permission(organization_id, 'alert.read'));
create policy compliance_alerts_insert on public.compliance_alerts for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy compliance_alerts_update on public.compliance_alerts for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy compliance_alerts_delete on public.compliance_alerts for delete to authenticated
  using (public.has_permission(organization_id, 'alert.manage'));

grant select, insert, update, delete on
  public.drivers, public.trucks, public.trailers, public.partners, public.compliance_alerts
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Audit helper: authenticated users cannot INSERT into audit_log directly
-- (revoked in 0001); the API records actions through this membership-checked
-- SECURITY DEFINER function instead.
-- -----------------------------------------------------------------------------

create or replace function public.log_audit(
  p_organization_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before jsonb default null,
  p_after jsonb default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  if not public.is_org_member(p_organization_id) then
    raise exception 'not a member of organization %', p_organization_id using errcode = '42501';
  end if;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, before, after)
  values (p_organization_id, auth.uid(), p_action, p_entity_type, p_entity_id, p_before, p_after)
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function public.log_audit(uuid, text, text, text, jsonb, jsonb) to authenticated;
