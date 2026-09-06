-- =============================================================================
-- Corridor — 0003 movements (Movement Builder core)
-- movements, cargo, seals, movement_events, movement_amendments.
-- The status state machine is enforced in the database (trigger) as well as
-- in the API, so no code path can skip a transition or edit a transmitted
-- manifest. movement_events is the append-only audit timeline and is
-- published over Realtime.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Per-organization counters (movement numbers)
-- -----------------------------------------------------------------------------

create table public.organization_counters (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key             text not null,
  value           bigint not null default 0,
  primary key (organization_id, key)
);

alter table public.organization_counters enable row level security;
-- No direct access; only next_movement_number() (SECURITY DEFINER) touches it.

create or replace function public.next_movement_number(p_org_id uuid, p_regime text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := 'movement:' || to_char(now() at time zone 'utc', 'YYYY');
  v_next bigint;
begin
  if not public.is_org_member(p_org_id) then
    raise exception 'not a member of organization %', p_org_id using errcode = '42501';
  end if;
  insert into public.organization_counters (organization_id, key, value)
  values (p_org_id, v_key, 1)
  on conflict (organization_id, key) do update set value = organization_counters.value + 1
  returning value into v_next;
  return p_regime || '-' || to_char(now() at time zone 'utc', 'YY') || '-' || lpad(v_next::text, 5, '0');
end;
$$;

grant execute on function public.next_movement_number(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- movements
-- -----------------------------------------------------------------------------

create table public.movements (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations(id) on delete cascade,
  regime                    text not null check (regime in ('ACE','ACI')),
  movement_number           text not null,
  trip_number               text,
  status                    text not null default 'draft' check (status in
                              ('draft','sent','accepted','rejected','released','held','arrived','cancelled')),
  crossing_point            jsonb,           -- { code, name }
  scheduled_crossing_at     timestamptz,
  driver_id                 uuid references public.drivers(id) on delete restrict,
  truck_id                  uuid references public.trucks(id) on delete restrict,
  trailer_id                uuid references public.trailers(id) on delete restrict,
  customs_reference_number  text,
  submitted_at              timestamptz,
  accepted_at               timestamptz,
  rejected_at               timestamptz,
  released_at               timestamptz,
  arrived_at                timestamptz,
  cancelled_at              timestamptz,
  notes                     text,
  created_by                uuid references auth.users(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (organization_id, movement_number)
);

create index movements_organization_id_idx on public.movements (organization_id);
create index movements_org_status_idx on public.movements (organization_id, status);
create index movements_org_created_idx on public.movements (organization_id, created_at desc);
create index movements_org_scheduled_idx on public.movements (organization_id, scheduled_crossing_at);
create index movements_driver_idx on public.movements (driver_id) where driver_id is not null;
create index movements_truck_idx on public.movements (truck_id) where truck_id is not null;
create index movements_trailer_idx on public.movements (trailer_id) where trailer_id is not null;

create trigger movements_set_updated_at
  before update on public.movements for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- State machine — single source of truth mirrored from packages/domain
-- (movement.ts MOVEMENT_TRANSITIONS). An integration test asserts parity.
-- -----------------------------------------------------------------------------

create or replace function public.movement_can_transition(p_from text, p_to text)
returns boolean
language sql
immutable
as $$
  select case p_from
    when 'draft'     then p_to in ('sent','cancelled')
    when 'sent'      then p_to in ('accepted','rejected','cancelled')
    when 'rejected'  then p_to in ('draft','sent','cancelled')
    when 'accepted'  then p_to in ('released','held','cancelled','sent')
    when 'held'      then p_to in ('released','cancelled')
    when 'released'  then p_to in ('arrived','cancelled')
    else false
  end;
$$;

create or replace function public.movement_is_editable(p_status text)
returns boolean
language sql
immutable
as $$
  select p_status in ('draft','rejected');
$$;

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
      or new.crossing_point is distinct from old.crossing_point
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

create trigger movements_guard
  before update on public.movements for each row execute function public.movements_guard();

-- -----------------------------------------------------------------------------
-- movement_events — append-only timeline (published via Realtime)
-- -----------------------------------------------------------------------------

create table public.movement_events (
  id              uuid primary key default gen_random_uuid(),
  movement_id     uuid not null references public.movements(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type      text not null check (event_type in
                    ('status_change','amendment','note','customs_response','ai_flag')),
  from_status     text,
  to_status       text,
  payload         jsonb,
  actor_type      text not null check (actor_type in ('user','system','customs_api','ai')),
  actor_id        uuid references auth.users(id) on delete set null,
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index movement_events_movement_idx on public.movement_events (movement_id, occurred_at);
create index movement_events_org_idx on public.movement_events (organization_id, occurred_at desc);

-- append-only
create or replace function public.reject_modification()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'P0001';
end;
$$;
create trigger movement_events_append_only
  before update or delete on public.movement_events for each row execute function public.reject_modification();

-- -----------------------------------------------------------------------------
-- movement_amendments
-- -----------------------------------------------------------------------------

create table public.movement_amendments (
  id               uuid primary key default gen_random_uuid(),
  movement_id      uuid not null references public.movements(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  amendment_number int not null,
  reason           text not null,
  diff             jsonb not null default '{}'::jsonb,
  status           text not null default 'submitted' check (status in ('draft','submitted','accepted','rejected')),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (movement_id, amendment_number)
);

create index movement_amendments_movement_idx on public.movement_amendments (movement_id);

-- -----------------------------------------------------------------------------
-- cargo — one row per shipment line
-- -----------------------------------------------------------------------------

create table public.cargo (
  id                    uuid primary key default gen_random_uuid(),
  movement_id           uuid not null references public.movements(id) on delete cascade,
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  line_number           int not null default 1,
  shipper_id            uuid references public.partners(id) on delete restrict,
  consignee_id          uuid references public.partners(id) on delete restrict,
  commodity_description text not null check (char_length(commodity_description) between 1 and 500),
  hs_code               text check (hs_code ~ '^\d{4}(\.\d{2}(\.\d{2}(\.\d{2})?)?)?$'),
  weight_kg             numeric(12,2) check (weight_kg > 0),
  piece_count           int check (piece_count > 0),
  packaging_type        text,
  entry_number          text,
  in_bond_number        text,
  value_amount          numeric(14,2) check (value_amount >= 0),
  value_currency        text check (value_currency in ('USD','CAD')),
  country_of_origin     text check (country_of_origin ~ '^[A-Z]{2}$'),
  source_document_id    uuid,                 -- FK added in Phase 4 (source_documents)
  extraction_confidence numeric(4,3) check (extraction_confidence between 0 and 1),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index cargo_movement_idx on public.cargo (movement_id, line_number);
create index cargo_organization_id_idx on public.cargo (organization_id);
create index cargo_commodity_search_idx on public.cargo using gin (to_tsvector('simple', commodity_description));

create trigger cargo_set_updated_at
  before update on public.cargo for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- seals
-- -----------------------------------------------------------------------------

create table public.seals (
  id              uuid primary key default gen_random_uuid(),
  movement_id     uuid not null references public.movements(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  trailer_id      uuid references public.trailers(id) on delete set null,
  seal_number     text not null check (char_length(seal_number) between 1 and 40),
  seal_type       text,
  applied_by      text,
  applied_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index seals_movement_idx on public.seals (movement_id);
create unique index seals_movement_number_unique on public.seals (movement_id, seal_number);

-- cargo/seals may only change while the parent movement is editable
create or replace function public.movement_children_guard()
returns trigger
language plpgsql
as $$
declare
  v_movement_id uuid := coalesce(new.movement_id, old.movement_id);
  v_status text;
begin
  select status into v_status from public.movements where id = v_movement_id;
  if v_status is null then
    raise exception 'movement % not found', v_movement_id using errcode = 'P0002';
  end if;
  if not public.movement_is_editable(v_status) then
    raise exception 'movement is not editable in status %', v_status using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger cargo_editable_guard
  before insert or update or delete on public.cargo for each row execute function public.movement_children_guard();
create trigger seals_editable_guard
  before insert or update or delete on public.seals for each row execute function public.movement_children_guard();

-- -----------------------------------------------------------------------------
-- compliance_alerts.movement_id FK deferred from 0002
-- -----------------------------------------------------------------------------

alter table public.compliance_alerts
  add constraint compliance_alerts_movement_id_fkey
  foreign key (movement_id) references public.movements(id) on delete cascade;
create index compliance_alerts_movement_idx on public.compliance_alerts (movement_id) where movement_id is not null;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

alter table public.movements           enable row level security;
alter table public.movement_events     enable row level security;
alter table public.movement_amendments enable row level security;
alter table public.cargo               enable row level security;
alter table public.seals               enable row level security;

-- movements: read with movement.read; create/edit with movement.write.
-- Status transitions are additionally permission-checked in the API
-- (transmit_to_customs / cancel / amend) — RLS can't see the intended transition.
-- Driver-portal users see movements assigned to them (movement.read_assigned).
create policy movements_select on public.movements for select to authenticated
  using (
    public.has_permission(organization_id, 'movement.read')
    or (
      public.has_permission(organization_id, 'movement.read_assigned')
      and driver_id in (select d.id from public.drivers d
                        join public.user_profiles up on lower(up.display_name) = lower(d.first_name || ' ' || d.last_name)
                        where up.user_id = (select auth.uid()))
    )
  );
create policy movements_insert on public.movements for insert to authenticated
  with check (public.has_permission(organization_id, 'movement.write'));
create policy movements_update on public.movements for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

-- movement_events: readable with the movement; insert by any member (API attributes actor)
create policy movement_events_select on public.movement_events for select to authenticated
  using (public.has_permission(organization_id, 'movement.read')
         or public.has_permission(organization_id, 'movement.read_assigned'));
create policy movement_events_insert on public.movement_events for insert to authenticated
  with check (public.is_org_member(organization_id));

-- movement_amendments
create policy movement_amendments_select on public.movement_amendments for select to authenticated
  using (public.has_permission(organization_id, 'movement.read'));
create policy movement_amendments_insert on public.movement_amendments for insert to authenticated
  with check (public.has_permission(organization_id, 'movement.amend'));
create policy movement_amendments_update on public.movement_amendments for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

-- cargo / seals follow movement.read / movement.write
create policy cargo_select on public.cargo for select to authenticated
  using (public.has_permission(organization_id, 'movement.read'));
create policy cargo_modify on public.cargo for all to authenticated
  using (public.has_permission(organization_id, 'movement.write'))
  with check (public.has_permission(organization_id, 'movement.write'));

create policy seals_select on public.seals for select to authenticated
  using (public.has_permission(organization_id, 'movement.read'));
create policy seals_modify on public.seals for all to authenticated
  using (public.has_permission(organization_id, 'movement.write'))
  with check (public.has_permission(organization_id, 'movement.write'));

grant select, insert, update, delete on
  public.movements, public.movement_events, public.movement_amendments, public.cargo, public.seals
  to authenticated, service_role;
revoke update, delete on public.movement_events from authenticated;

-- -----------------------------------------------------------------------------
-- Realtime: timeline + status changes push to the browser (RLS applies)
-- -----------------------------------------------------------------------------

alter publication supabase_realtime add table public.movement_events;
alter publication supabase_realtime add table public.movements;
