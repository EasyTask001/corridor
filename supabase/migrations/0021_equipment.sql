-- =============================================================================
-- Corridor — 0021 multi-trailer, per-trailer seals, truck and trailer detail
-- (Avaal parity gap 6)
--
--   1. public.equipment_types — the CBP/CBSA equipment description codes a
--      trailer is filed under; trailers.trailer_type moves from the home-made
--      enum onto it.
--   2. public.trucks gains the conveyance detail CBP asks for (DOT number,
--      hazmat capability, insurance).
--   3. public.equipment_plates — the extra licence plates a truck or trailer
--      carries; the primary plate stays on the parent row.
--   4. public.movement_trailers — a crossing pulls one, two (or zero) trailers;
--      movements.trailer_id is backfilled into it and dropped.
--   5. seals hang off a trailer slot (or the truck), capped at 4 per trailer
--      and 1 per truck; movements.is_empty declares an empty trailer / trip.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. equipment_types
--
-- Why a new table: this is a global reference list, not tenant data. The grain
-- is one equipment description code (X12 DE40, ACE Appendix N — the list
-- Avaal's trailer-type dropdown is built from). `ports` is the other global
-- lookup but its grain is a customs location; `trailers.trailer_type` was a
-- seven-value check constraint, which cannot carry a label or a regime scope
-- and cannot be extended without a migration. A `text check (...)` enum is
-- what the repo uses for closed lifecycle vocabularies; a code list with ~60
-- entries that CBP revises is a lookup row, so it gets a table.
-- -----------------------------------------------------------------------------

create table public.equipment_types (
  code         text primary key check (code ~ '^[A-Z0-9]{2}$'),
  label        text not null,
  regime_scope text not null default 'both' check (regime_scope in ('ACE','ACI','both'))
);

-- Truck-relevant subset of ACE Appendix N (rail cars, vessels and aircraft
-- are left out; both regimes accept the same trailer/container codes).
insert into public.equipment_types (code, label, regime_scope) values
  ('TL', 'Trailer (not otherwise specified)', 'both'),
  ('TF', 'Trailer, dry freight', 'both'),
  ('RT', 'Controlled temperature trailer (reefer)', 'both'),
  ('TW', 'Trailer, refrigerated', 'both'),
  ('TI', 'Trailer, insulated', 'both'),
  ('TM', 'Trailer, insulated/ventilated', 'both'),
  ('TA', 'Trailer, heated/insulated/ventilated', 'both'),
  ('TQ', 'Trailer, electric heat', 'both'),
  ('FT', 'Flat bed trailer', 'both'),
  ('FH', 'Flat bed trailer with headboards', 'both'),
  ('FR', 'Flat bed trailer, removable sides', 'both'),
  ('OT', 'Open-top / flatbed trailer', 'both'),
  ('SD', 'Single-drop trailer (step deck)', 'both'),
  ('DD', 'Double-drop trailer', 'both'),
  ('DT', 'Drop back trailer', 'both'),
  ('RA', 'Fixed-rack flatbed trailer (A-frame)', 'both'),
  ('RS', 'Fixed-rack single-drop trailer', 'both'),
  ('RD', 'Fixed-rack double-drop trailer', 'both'),
  ('ST', 'Removable side trailer', 'both'),
  ('TT', 'Telescoping trailer', 'both'),
  ('TB', 'Trailer, board', 'both'),
  ('TC', 'Trailer, car', 'both'),
  ('TP', 'Trailer, pneumatic', 'both'),
  ('TG', 'Trailer, tank (gas)', 'both'),
  ('TJ', 'Trailer, tank (chemicals)', 'both'),
  ('TK', 'Trailer, tank (food grade liquid)', 'both'),
  ('PT', 'Protected trailer', 'both'),
  ('HV', 'High cube van', 'both'),
  ('CV', 'Close van', 'both'),
  ('OV', 'Open top van', 'both'),
  ('SV', 'Van, special dimensions', 'both'),
  ('CH', 'Chassis', 'both'),
  ('CB', 'Chassis, gooseneck', 'both'),
  ('CC', 'Container resting on a chassis', 'both'),
  ('CN', 'Container', 'both'),
  ('CL', 'Container, closed top', 'both'),
  ('CU', 'Container, open top', 'both'),
  ('CZ', 'Refrigerated container', 'both'),
  ('CI', 'Container, insulated', 'both'),
  ('CX', 'Container, tank', 'both'),
  ('CG', 'Container, tank (gas)', 'both'),
  ('CW', 'Container, tank (chemicals)', 'both'),
  ('CQ', 'Container, tank (food grade liquid)', 'both'),
  ('BK', 'Container, bulk', 'both'),
  ('PL', 'Container, platform', 'both'),
  ('LS', 'Half height flat rack', 'both'),
  ('AC', 'Closed container', 'both'),
  ('AT', 'Closed container (controlled temperature)', 'both'),
  ('TV', 'Truck, van', 'both'),
  ('TO', 'Truck, open top', 'both'),
  ('TH', 'Truck, open top high side', 'both'),
  ('TU', 'Truck, open top low side', 'both'),
  ('PU', 'Pick-up truck', 'both'),
  ('TR', 'Tractor', 'both'),
  ('BG', 'Bogie', 'both'),
  ('LU', 'Load/unload device on equipment', 'both'),
  ('GS', 'Generator set', 'both');

alter table public.equipment_types enable row level security;
create policy equipment_types_select on public.equipment_types for select to authenticated
  using (true);
grant select on public.equipment_types to authenticated, service_role;

-- trailers.trailer_type: the seven home-made values become their CBP code.
-- (dry_van → TF, reefer → RT, flatbed → FT, tanker → TK, container_chassis →
-- CH, step_deck → SD, other → TL.)
alter table public.trailers drop constraint trailers_trailer_type_check;
update public.trailers set trailer_type = case trailer_type
  when 'dry_van'           then 'TF'
  when 'reefer'            then 'RT'
  when 'flatbed'           then 'FT'
  when 'tanker'            then 'TK'
  when 'container_chassis' then 'CH'
  when 'step_deck'         then 'SD'
  else 'TL'
end;
alter table public.trailers alter column trailer_type set default 'TF';
alter table public.trailers
  add constraint trailers_trailer_type_fkey
  foreign key (trailer_type) references public.equipment_types(code);

-- -----------------------------------------------------------------------------
-- 2. trucks: conveyance detail (same grain — columns, not a table)
-- -----------------------------------------------------------------------------

alter table public.trucks
  add column dot_number        text check (dot_number ~ '^\d{1,8}$'),
  add column hazmat_capable    boolean not null default false,
  add column insurance_company text,
  add column insurance_amount  numeric(12,2) check (insurance_amount >= 0),
  add column insurance_year    int check (insurance_year between 1990 and 2100);

-- Targets for the composite foreign keys below (same reason as
-- drivers_id_organization_id_key in 0020): a child row naming a truck or a
-- trailer must name that unit's organization too.
alter table public.trucks   add constraint trucks_id_organization_id_key   unique (id, organization_id);
alter table public.trailers add constraint trailers_id_organization_id_key unique (id, organization_id);

-- -----------------------------------------------------------------------------
-- 3. equipment_plates
--
-- Why a new table: the grain is one additional licence plate on one unit. A
-- truck or trailer registered in more than one jurisdiction carries up to four
-- plates and CBP wants each one; `trucks`/`trailers` are one-per-unit and hold
-- the primary plate as plate_number/plate_jurisdiction. Widening them would
-- mean plate_number_2..4 column families, and a jsonb array of plates is
-- exactly the "structured repeating data" the schema rules send to a child
-- table (see commodity_hazmat). No existing table has the "plate on a unit"
-- grain.
-- -----------------------------------------------------------------------------

create table public.equipment_plates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Exactly one owner.
  truck_id        uuid,
  trailer_id      uuid,
  plate_number    text not null check (char_length(plate_number) between 1 and 20),
  jurisdiction    text not null check (jurisdiction ~ '^[A-Z]{2}$'),
  -- 1..4; the primary plate on the parent row is not counted here.
  position        int not null check (position between 1 and 4),
  created_at      timestamptz not null default now(),
  constraint equipment_plates_owner_check check ((truck_id is null) <> (trailer_id is null)),
  constraint equipment_plates_truck_id_fkey foreign key (truck_id, organization_id)
    references public.trucks (id, organization_id) on delete cascade,
  constraint equipment_plates_trailer_id_fkey foreign key (trailer_id, organization_id)
    references public.trailers (id, organization_id) on delete cascade,
  unique (truck_id, position),
  unique (trailer_id, position)
);

create index equipment_plates_organization_id_idx on public.equipment_plates (organization_id);
create index equipment_plates_truck_idx on public.equipment_plates (truck_id) where truck_id is not null;
create index equipment_plates_trailer_idx on public.equipment_plates (trailer_id) where trailer_id is not null;

-- -----------------------------------------------------------------------------
-- 4. movement_trailers
--
-- Why a new table: the grain is one trailer on one crossing, in tow order. A
-- tractor regularly pulls two (LCV / turnpike double) and a bobtail pulls
-- none; `movements` is one-per-crossing and could only name a single trailer
-- (movements.trailer_id), which is the gap. `trailers` is one-per-unit and
-- cannot hold a per-trip position. Same shape as movement_crew (0020).
-- -----------------------------------------------------------------------------

create table public.movement_trailers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  movement_id     uuid not null references public.movements(id) on delete cascade,
  -- `restrict`, exactly as movements.trailer_id was: equipment that crossed on
  -- a filed manifest cannot be deleted out from under it.
  trailer_id      uuid not null,
  position        int not null default 1,
  created_at      timestamptz not null default now(),
  unique (movement_id, trailer_id),
  constraint movement_trailers_trailer_id_fkey foreign key (trailer_id, organization_id)
    references public.trailers (id, organization_id) on delete restrict
);

create index movement_trailers_organization_id_idx on public.movement_trailers (organization_id);
create index movement_trailers_movement_idx on public.movement_trailers (movement_id, position);
create index movement_trailers_trailer_idx on public.movement_trailers (trailer_id);

-- Backfill before the editable guard is attached, so transmitted movements
-- keep their trailer.
insert into public.movement_trailers (organization_id, movement_id, trailer_id, position)
select m.organization_id, m.id, m.trailer_id, 1
from public.movements m
where m.trailer_id is not null;

-- -----------------------------------------------------------------------------
-- 5. seals follow the trailer slot; is_empty on the movement
-- -----------------------------------------------------------------------------

-- "Empty Trailer" (ACE) / "Empty Trip" (ACI): the crossing carries no goods.
alter table public.movements add column is_empty boolean not null default false;

alter table public.seals
  add column movement_trailer_id uuid references public.movement_trailers(id) on delete cascade;

update public.seals s
set movement_trailer_id = mt.id
from public.movement_trailers mt
where mt.movement_id = s.movement_id and mt.trailer_id = s.trailer_id;

alter table public.seals drop column trailer_id;

create index seals_movement_trailer_idx on public.seals (movement_trailer_id)
  where movement_trailer_id is not null;

-- CBP accepts up to four seals per trailer and one on the truck itself
-- (movement_trailer_id null). The slot must also be on the same movement.
create or replace function public.seals_limit()
returns trigger
language plpgsql
as $$
declare
  v_count int;
  v_limit int;
begin
  if new.movement_trailer_id is null then
    v_limit := 1;
    select count(*) into v_count from public.seals
      where movement_id = new.movement_id and movement_trailer_id is null and id <> new.id;
  else
    if not exists (
      select 1 from public.movement_trailers mt
      where mt.id = new.movement_trailer_id and mt.movement_id = new.movement_id
    ) then
      raise exception 'seal trailer is not on this movement' using errcode = 'P0001';
    end if;
    v_limit := 4;
    select count(*) into v_count from public.seals
      where movement_trailer_id = new.movement_trailer_id and id <> new.id;
  end if;
  if v_count >= v_limit then
    raise exception 'seal limit reached: at most % seal(s) per %', v_limit,
      case when new.movement_trailer_id is null then 'truck' else 'trailer' end
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger seals_limit
  before insert or update on public.seals for each row execute function public.seals_limit();

-- movements_guard() — live definition is 0020_crew_and_travel_documents.sql:100-191
-- (0008 identity immutability, in-trigger permission checks and the
-- lifecycle-timestamp anti-spoof block; 0018 port_id + carrier_code; 0020
-- dropped driver_id). Rebuilt verbatim from that body with the trailer_id term
-- replaced by is_empty in v_manifest_changed: the trailers now live in
-- movement_trailers, whose edits are frozen by movement_children_guard().
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
    or new.is_empty is distinct from old.is_empty
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

-- Driver-portal access to a trailer follows the crossing it is on — live
-- definition is 0009_predictive_assembly.sql:87-95; only the join changes. Rebuilt before
-- the column it referenced is dropped.
drop policy trailers_select on public.trailers;
create policy trailers_select on public.trailers for select to authenticated
  using (
    public.has_permission(organization_id, 'trailer.read')
    or exists (
      select 1 from public.movement_trailers mt
      where mt.trailer_id = trailers.id and public.is_assigned_movement(mt.movement_id)
    )
  );

-- Dropping the column also drops movements_trailer_idx, which indexed it.
alter table public.movements drop column trailer_id;

-- movement_trailers is an ordinary movement child (it carries movement_id), so
-- movement_children_guard()'s else-branch (live definition 0019) resolves it;
-- only the trigger is needed. Attached after the backfill above.
create trigger movement_trailers_editable_guard
  before insert or update or delete on public.movement_trailers
  for each row execute function public.movement_children_guard();

-- -----------------------------------------------------------------------------
-- 6. RLS
-- -----------------------------------------------------------------------------

alter table public.equipment_plates  enable row level security;
alter table public.movement_trailers enable row level security;

-- Plates follow the unit they are bolted to.
create policy equipment_plates_select on public.equipment_plates for select to authenticated
  using (
    case when truck_id is not null
      then public.has_permission(organization_id, 'truck.read')
      else public.has_permission(organization_id, 'trailer.read')
    end
  );
create policy equipment_plates_modify on public.equipment_plates for all to authenticated
  using (
    case when truck_id is not null
      then public.has_permission(organization_id, 'truck.write')
      else public.has_permission(organization_id, 'trailer.write')
    end
  )
  with check (
    case when truck_id is not null
      then public.has_permission(organization_id, 'truck.write')
      else public.has_permission(organization_id, 'trailer.write')
    end
  );

-- Trailer slots follow movement.read / movement.write, and a crew member sees
-- the crossing they are on — same shape as movement_crew and seals.
create policy movement_trailers_select on public.movement_trailers for select to authenticated
  using (
    public.has_permission(organization_id, 'movement.read')
    or public.is_assigned_movement(movement_id)
  );
create policy movement_trailers_modify on public.movement_trailers for all to authenticated
  using (public.has_permission(organization_id, 'movement.write'))
  with check (public.has_permission(organization_id, 'movement.write'));

grant select, insert, update, delete on public.equipment_plates, public.movement_trailers
  to authenticated, service_role;
