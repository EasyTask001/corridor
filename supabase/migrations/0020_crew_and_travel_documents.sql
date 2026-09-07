-- =============================================================================
-- Corridor — 0020 multi-person crew, roles and travel documents (Avaal parity gap 5)
--
--   1. public.drivers gains the person-level data CBP/CBSA ask about every body
--      in the cab (person type, gender, hazmat endorsement, US address).
--   2. public.movement_crew — a crossing carries a crew, not a single driver;
--      movements.driver_id is backfilled into it and dropped.
--   3. public.driver_documents — the passport / FAST / NEXUS / visa travel
--      documents a crew member presents at the booth; drivers.fast_card_* is
--      migrated into it and dropped.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. drivers: person-level fields
--
-- Same grain (one person on the carrier's roster), so these are columns, not a
-- table. A passenger is a person the carrier declares in the cab who does not
-- drive, so the licence columns stop being mandatory and a check keeps them
-- mandatory for everyone who does.
-- -----------------------------------------------------------------------------

alter table public.drivers
  add column person_type        text not null default 'driver'
                                  check (person_type in ('driver','passenger')),
  add column gender             text check (gender in ('M','F','X')),
  add column hazmat_endorsement boolean not null default false,
  -- Free-form postal address, exactly like partners.address: CBP asks for a US
  -- destination address for a non-US crew member.
  add column us_address         jsonb not null default '{}'::jsonb;

alter table public.drivers
  alter column license_number drop not null,
  alter column license_jurisdiction drop not null;

alter table public.drivers
  add constraint drivers_license_required_check
  check (person_type = 'passenger'
         or (license_number is not null and license_jurisdiction is not null));

-- Target for the composite foreign keys below: a child row naming a person must
-- name that person's organization too, so a tenant cannot attach a crew slot or
-- a travel document to somebody else's driver. RLS alone cannot see across the
-- two tables on INSERT, so this is enforced by the key rather than a policy.
alter table public.drivers
  add constraint drivers_id_organization_id_key unique (id, organization_id);

-- -----------------------------------------------------------------------------
-- 2. movement_crew
--
-- Why a new table: the grain is one person on one crossing, with the role they
-- hold on that crossing. `movements` is one-per-crossing and could only ever
-- name a single driver (movements.driver_id), which is the gap — CBP/CBSA
-- accept a person in charge plus additional crew members and passengers, and
-- the same person is a person-in-charge on one trip and a crew member on the
-- next, so the role is a property of the pairing, not of the person.
-- `drivers` is one-per-person and cannot hold a per-trip role either. No
-- existing table has the "person on a trip" grain, so it gets its own.
-- -----------------------------------------------------------------------------

create table public.movement_crew (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  movement_id     uuid not null references public.movements(id) on delete cascade,
  -- `restrict`, exactly as movements.driver_id was: somebody who has crossed a
  -- border on a filed manifest cannot be deleted out from under it. The key is
  -- composite so the person must belong to this row's organization.
  driver_id       uuid not null,
  role            text not null default 'crew_member'
                    check (role in ('person_in_charge','crew_member','passenger')),
  position        int not null default 1,
  created_at      timestamptz not null default now(),
  unique (movement_id, driver_id),
  constraint movement_crew_driver_id_fkey foreign key (driver_id, organization_id)
    references public.drivers (id, organization_id) on delete restrict
);

create index movement_crew_organization_id_idx on public.movement_crew (organization_id);
create index movement_crew_movement_idx on public.movement_crew (movement_id, position);
create index movement_crew_driver_idx on public.movement_crew (driver_id);
-- Exactly one person in charge per crossing; the API and the UI enforce the
-- same rule, this is what makes it true.
create unique index movement_crew_pic_unique on public.movement_crew (movement_id)
  where role = 'person_in_charge';

-- The assigned driver becomes that movement's person in charge. Runs before
-- the editable guard is attached below, so already-transmitted movements keep
-- their crew.
insert into public.movement_crew (organization_id, movement_id, driver_id, role, position)
select m.organization_id, m.id, m.driver_id, 'person_in_charge', 1
from public.movements m
where m.driver_id is not null;

-- movements_guard()'s manifest-changed expression (live definition is
-- 0018_ports_and_carrier_codes.sql:239-334, not 0003/0008 — 0008 added identity
-- immutability, in-trigger permission checks and the lifecycle-timestamp
-- anti-spoof block, and 0018 swapped crossing_point for port_id + carrier_code;
-- none of that may be lost here). Rebuilt verbatim from that body with only the
-- driver_id term removed from v_manifest_changed: the crew now lives in
-- movement_crew, whose edits are frozen by movement_children_guard() instead.
create or replace function public.movements_guard()
returns trigger
language plpgsql
as $$
declare
  v_manifest_changed boolean;
  v_required_permission text;
begin
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.movement_number is distinct from old.movement_number
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'movement identity fields are immutable' using errcode = 'P0001';
  end if;

  v_manifest_changed :=
       new.regime is distinct from old.regime
    or new.port_id is distinct from old.port_id
    or new.carrier_code is distinct from old.carrier_code
    or new.scheduled_crossing_at is distinct from old.scheduled_crossing_at
    or new.truck_id is distinct from old.truck_id
    or new.trailer_id is distinct from old.trailer_id
    or new.trip_number is distinct from old.trip_number
    or new.notes is distinct from old.notes;

  if new.status is distinct from old.status
     and not public.movement_can_transition(old.status, new.status) then
    raise exception 'invalid movement transition % -> %', old.status, new.status
      using errcode = 'P0001';
  end if;

  if current_user = 'authenticated' then
    if v_manifest_changed then
      v_required_permission := case
        when old.status = 'accepted' and new.status = 'sent' then 'movement.amend'
        else 'movement.write'
      end;
      if not public.has_permission(old.organization_id, v_required_permission) then
        raise exception 'permission denied: % required', v_required_permission
          using errcode = '42501';
      end if;
    end if;

    if new.customs_reference_number is distinct from old.customs_reference_number
       and not public.has_permission(old.organization_id, 'movement.transmit_to_customs') then
      raise exception 'permission denied: movement.transmit_to_customs required'
        using errcode = '42501';
    end if;

    if new.status is distinct from old.status then
      v_required_permission := case
        when new.status = 'cancelled' then 'movement.cancel'
        when old.status = 'accepted' and new.status = 'sent' then 'movement.amend'
        when new.status = 'sent' then 'movement.transmit_to_customs'
        when new.status in ('accepted', 'rejected', 'released', 'held')
          then 'movement.transmit_to_customs'
        else 'movement.write'
      end;
      if not public.has_permission(old.organization_id, v_required_permission) then
        raise exception 'permission denied: % required', v_required_permission
          using errcode = '42501';
      end if;
    end if;

    -- Lifecycle timestamps are produced by this trigger, never supplied by a
    -- client. Preserve their old values before stamping the current action.
    new.submitted_at := old.submitted_at;
    new.accepted_at := old.accepted_at;
    new.rejected_at := old.rejected_at;
    new.released_at := old.released_at;
    new.arrived_at := old.arrived_at;
    new.cancelled_at := old.cancelled_at;
  end if;

  if new.status is distinct from old.status then
    case new.status
      when 'sent'      then new.submitted_at := coalesce(new.submitted_at, now());
      when 'accepted'  then new.accepted_at  := now();
      when 'rejected'  then new.rejected_at  := now();
      when 'released'  then new.released_at  := now();
      when 'arrived'   then new.arrived_at   := now();
      when 'cancelled' then new.cancelled_at := now();
      else null;
    end case;
  elsif not public.movement_is_editable(old.status) and v_manifest_changed then
    raise exception 'movement % is not editable in status %', old.movement_number, old.status
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Dropping the column also drops movements_driver_idx, which indexed it.
alter table public.movements drop column driver_id;

-- movement_crew is an ordinary movement child (it carries movement_id), so
-- movement_children_guard()'s existing else-branch already resolves it — the
-- function body needs no change, only the trigger. Attached after the backfill
-- above so rows can be seeded onto transmitted movements.
create trigger movement_crew_editable_guard
  before insert or update or delete on public.movement_crew
  for each row execute function public.movement_children_guard();

-- -----------------------------------------------------------------------------
-- 3. driver_documents
--
-- Why a new table: the grain is one travel document held by one person. CBP's
-- WHTI list accepts ~20 document types and a crew member routinely presents
-- several at once (a passport plus a FAST card plus a visa), each with its own
-- number, issuer, issue date and expiry. `drivers` is one-per-person and could
-- only carry the single hard-coded pair fast_card_number/fast_card_expiry;
-- widening it would mean passport_number/nexus_number/visa_number column
-- families, and a jsonb bag is not allowed (jsonb is for provider payloads,
-- free-form metadata and addresses only). No existing table has the "one
-- document held by one person" grain.
-- -----------------------------------------------------------------------------

create table public.driver_documents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  driver_id       uuid not null,
  -- The CBP/CBSA (WHTI) list Avaal files against.
  document_type   text not null check (document_type in
                    ('passport','us_passport_card','fast','nexus','sentri',
                     'enhanced_drivers_license','permanent_resident_card','us_alien_registration',
                     'visa_immigrant','visa_non_immigrant','laser_visa_bcc','military_id',
                     'merchant_mariner','native_american_inac','dhs_reentry_permit',
                     'dhs_refugee_travel','birth_certificate','citizenship_card',
                     'certificate_of_naturalization','other')),
  document_number text not null check (char_length(document_number) between 1 and 40),
  issuing_country text check (issuing_country ~ '^[A-Z]{2}$'),
  issuing_state   text,
  issued_on       date,
  expires_on      date,
  -- The document this person normally travels on, printed first on the crew list.
  is_primary      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (driver_id, document_type, document_number),
  -- Composite, same reason as movement_crew: the document's organization must
  -- be the person's organization.
  constraint driver_documents_driver_id_fkey foreign key (driver_id, organization_id)
    references public.drivers (id, organization_id) on delete cascade
);

create index driver_documents_organization_id_idx on public.driver_documents (organization_id);
create index driver_documents_driver_idx on public.driver_documents (driver_id, document_type);

create trigger driver_documents_set_updated_at
  before update on public.driver_documents for each row execute function public.set_updated_at();

-- FAST cards move out of drivers and become ordinary travel documents.
insert into public.driver_documents (organization_id, driver_id, document_type, document_number,
                                     expires_on, is_primary)
select organization_id, id, 'fast', fast_card_number, fast_card_expiry, false
from public.drivers
where fast_card_number is not null;

alter table public.drivers
  drop column fast_card_number,
  drop column fast_card_expiry;

-- -----------------------------------------------------------------------------
-- 4. Driver-portal access follows the crew, not the dropped column
--
-- Live definition is 0009_predictive_assembly.sql:12-27; only the movement ->
-- driver join changes. Every policy built on it (movements_select,
-- movement_events_select, cargo/commodities, seals, trucks, trailers, partners,
-- shipments, source_documents) keeps working unchanged.
-- -----------------------------------------------------------------------------

create or replace function public.is_assigned_movement(p_movement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.movement_crew mc
    join public.movements m on m.id = mc.movement_id
    join public.drivers d on d.id = mc.driver_id and d.organization_id = m.organization_id
    where m.id = p_movement_id
      and d.user_id = auth.uid()
      and public.has_permission(m.organization_id, 'movement.read_assigned')
  );
$$;

-- -----------------------------------------------------------------------------
-- 5. RLS
-- -----------------------------------------------------------------------------

alter table public.movement_crew     enable row level security;
alter table public.driver_documents  enable row level security;

-- Crew follows movement.read / movement.write, and a crew member sees the
-- crossing they are on — same shape as seals.
create policy movement_crew_select on public.movement_crew for select to authenticated
  using (
    public.has_permission(organization_id, 'movement.read')
    or public.is_assigned_movement(movement_id)
  );
create policy movement_crew_modify on public.movement_crew for all to authenticated
  using (public.has_permission(organization_id, 'movement.write'))
  with check (public.has_permission(organization_id, 'movement.write'));

create policy driver_documents_select on public.driver_documents for select to authenticated
  using (public.has_permission(organization_id, 'driver.read'));
create policy driver_documents_modify on public.driver_documents for all to authenticated
  using (public.has_permission(organization_id, 'driver.write'))
  with check (public.has_permission(organization_id, 'driver.write'));

grant select, insert, update, delete on public.movement_crew, public.driver_documents
  to authenticated, service_role;
