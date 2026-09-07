-- =============================================================================
-- Corridor — 0019 shipments as a first-class entity (Avaal parity gaps 2, 3, 4)
--
--   1. public.shipments — the customs filing unit (a PAPS/PARS/bill), created
--      and searched independently of the truck movement it eventually rides on.
--   2. public.cargo -> public.commodities — cargo lines stop hanging off the
--      movement and hang off the shipment instead, which is where the shipper,
--      consignee, entry number and in-bond data actually belong.
--   3. public.commodity_hazmat — up to three dangerous-goods declarations per
--      commodity line.
--
-- Renames (not drop/create) so existing rows survive: every cargo row is
-- migrated onto a backfilled shipment below.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. shipments
--
-- Why a new table: the grain is one customs shipment — a single PAPS/PARS
-- control number filed with CBP/CBSA. It is NOT the same grain as a movement
-- (one truck crossing carries many shipments, and a shipment is created,
-- searched and assigned long before it is put on a truck — dispatchers key
-- shipments in from a broker's email, then attach them to whichever trip takes
-- them). `movements` is one-per-crossing and already carries the trip, crew and
-- conveyance; `cargo` was one-per-commodity-line and carried the
-- shipper/consignee/entry fields at the wrong grain (they repeat identically
-- across every line of the same bill, and there was nowhere to put a shipment
-- that is not on a truck yet). No existing table has the "one customs filing"
-- grain, so it gets its own.
-- -----------------------------------------------------------------------------

create table public.shipments (
  id                          uuid primary key default gen_random_uuid(),
  organization_id             uuid not null references public.organizations(id) on delete cascade,
  regime                      text not null check (regime in ('ACE','ACI')),
  -- A shipment outlives the trip it was booked on: deleting a draft movement
  -- releases its shipments back to the unassigned pool rather than destroying
  -- customs records.
  movement_id                 uuid references public.movements(id) on delete set null,
  -- Snapshot of the filing carrier code, same rule as movements.carrier_code
  -- (0018): the control number is built from it and must not move if the org
  -- edits its codes later.
  carrier_code                text not null,
  shipment_type               text check (shipment_type in
                                ('regular_bill','section_321','goods_astray','free_of_duty_7523',
                                 'free_return_us_goods_3311','unaccounted_articles_3299','in_bond')),
  cargo_type                  text check (cargo_type in ('regular','consolidated','csa','a49','e29b')),
  -- The carrier-assigned part of the control number (the PAPS/PARS/bill
  -- number). `control_number` below is the full number CBP/CBSA see.
  control_reference           text not null check (control_reference ~ '^[A-Z0-9]{4,20}$'),
  -- Denormalised copy maintained by shipments_control_number(). The default is
  -- a placeholder the trigger always overwrites — BEFORE INSERT runs before the
  -- NOT NULL check, but no writer should have to supply the value.
  control_number              text not null default '',
  is_pars                     boolean not null default false,
  entry_number                text,
  entry_port_id               uuid references public.ports(id),
  in_bond_entry_type          text check (in_bond_entry_type in ('IT','TE','IE')),
  in_bond_destination_port_id uuid references public.ports(id),
  in_bond_number              text,
  shipper_id                  uuid references public.partners(id) on delete restrict,
  consignee_id                uuid references public.partners(id) on delete restrict,
  -- ACI-only delivery detail.
  destination_port_id         uuid references public.ports(id),
  sublocation_port_id         uuid references public.ports(id),
  loading_country             text check (loading_country ~ '^[A-Z]{2}$'),
  loading_province            text,
  loading_city                text,
  -- Free-form postal address, exactly like partners.address.
  delivery_address            jsonb not null default '{}'::jsonb,
  consignee_business_number   text,
  status                      text not null default 'draft' check (status in
                                ('draft','sent','accepted','rejected','entry_on_file','released',
                                 'held','arrived','cancelled')),
  entry_on_file_at            timestamptz,
  released_at                 timestamptz,
  arrived_at                  timestamptz,
  cancelled_at                timestamptz,
  -- FK added in Task 11 together with the import_batches table.
  import_batch_id             uuid,
  source_document_id          uuid references public.source_documents(id) on delete set null,
  notes                       text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  -- ACE files a shipment type, ACI a cargo type; never both, never neither.
  constraint shipments_regime_type_check check (
    (regime = 'ACE' and shipment_type is not null and cargo_type is null)
    or (regime = 'ACI' and cargo_type is not null and shipment_type is null)
  ),
  unique (organization_id, control_number)
);

create index shipments_organization_id_idx on public.shipments (organization_id);
create index shipments_org_status_idx on public.shipments (organization_id, status);
create index shipments_movement_idx on public.shipments (movement_id) where movement_id is not null;
create index shipments_control_search_idx on public.shipments
  using gin (to_tsvector('simple', control_number));

create trigger shipments_set_updated_at
  before update on public.shipments for each row execute function public.set_updated_at();

-- The full control number CBP/CBSA see. Task 8 extends this with the
-- "include PARS" rule; keep it a single small function.
create or replace function public.shipments_control_number()
returns trigger
language plpgsql
as $$
begin
  new.control_number := new.carrier_code || new.control_reference;
  return new;
end;
$$;

create trigger shipments_control_number
  before insert or update on public.shipments for each row execute function public.shipments_control_number();

-- -----------------------------------------------------------------------------
-- 2. cargo -> commodities
-- -----------------------------------------------------------------------------

-- The child guard is rebuilt at the bottom of this file; drop it first so the
-- backfill below can move rows that belong to already-transmitted movements.
drop trigger cargo_editable_guard on public.cargo;

alter table public.cargo rename to commodities;
alter trigger cargo_set_updated_at on public.commodities rename to commodities_set_updated_at;
alter index cargo_pkey rename to commodities_pkey;
alter index cargo_organization_id_idx rename to commodities_organization_id_idx;
alter index cargo_commodity_search_idx rename to commodities_commodity_search_idx;
alter table public.commodities rename constraint cargo_source_document_id_fkey
  to commodities_source_document_id_fkey;
alter table public.commodities rename column piece_count to quantity;

-- Policies that read the columns about to be dropped (cargo_* here,
-- partners_select's driver-portal branch in 0009_predictive_assembly.sql:97)
-- are recreated against `shipments` in section 6.
drop policy cargo_select on public.commodities;
drop policy cargo_modify on public.commodities;
drop policy partners_select on public.partners;

alter table public.commodities
  add column shipment_id       uuid references public.shipments(id) on delete cascade,
  add column quantity_unit     text,
  add column weight_unit       text not null default 'KG' check (weight_unit in ('KG','LB')),
  add column marks_and_numbers text,
  add column is_consolidated   boolean not null default false;

-- Backfill: one shipment per movement that already has lines, carrying that
-- movement's first line's shipper/consignee. The control reference is derived
-- from the movement id so it is unique and obviously machine-generated;
-- 'XXXX' stands in for pre-0018 movements that never got a carrier code.
insert into public.shipments (organization_id, regime, movement_id, carrier_code, shipment_type,
                              cargo_type, control_reference, status, shipper_id, consignee_id)
select distinct on (m.id)
  m.organization_id,
  m.regime,
  m.id,
  coalesce(m.carrier_code, 'XXXX'),
  case when m.regime = 'ACE' then 'regular_bill' end,
  case when m.regime = 'ACI' then 'regular' end,
  'MIG' || upper(substr(replace(m.id::text, '-', ''), 1, 16)),
  m.status,
  c.shipper_id,
  c.consignee_id
from public.movements m
join public.commodities c on c.movement_id = m.id
order by m.id, c.line_number;

update public.commodities c
set shipment_id = s.id
from public.shipments s
where s.movement_id = c.movement_id;

-- Dropping movement_id also drops cargo_movement_idx, which indexed it.
alter table public.commodities
  alter column shipment_id set not null,
  drop column movement_id,
  drop column shipper_id,
  drop column consignee_id,
  drop column entry_number,
  drop column in_bond_number;

create index commodities_shipment_idx on public.commodities (shipment_id, line_number);

-- -----------------------------------------------------------------------------
-- 3. commodity_hazmat
--
-- Why a new table: the grain is one dangerous-goods declaration on one
-- commodity line, and CBP/CBSA accept up to three per line. That is repeating
-- structured data with its own validated shape (UN code, description, 24-hour
-- emergency contact), so it cannot live on `commodities` without inventing
-- un_code_1/2/3 column triplets, and it must not be a jsonb bag (jsonb is for
-- provider payloads, free-form metadata and addresses only).
-- -----------------------------------------------------------------------------

create table public.commodity_hazmat (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  commodity_id      uuid not null references public.commodities(id) on delete cascade,
  position          int not null check (position between 1 and 3),
  un_code           text not null check (un_code ~ '^UN\d{4}$'),
  description       text,
  emergency_contact text,
  emergency_phone   text,
  created_at        timestamptz not null default now(),
  unique (commodity_id, position)
);

create index commodity_hazmat_organization_id_idx on public.commodity_hazmat (organization_id);

-- -----------------------------------------------------------------------------
-- 4. movement_events.shipment_id — a timeline row can now name a shipment.
-- -----------------------------------------------------------------------------

alter table public.movement_events
  add column shipment_id uuid references public.shipments(id) on delete set null;

-- -----------------------------------------------------------------------------
-- 5. Guards
-- -----------------------------------------------------------------------------

-- Regime parity with the movement, the manifest edit-lock, and the rule that a
-- shipment may only change trips while it is still draft/rejected.
create or replace function public.shipments_guard()
returns trigger
language plpgsql
as $$
declare
  v_regime text;
  v_status text;
begin
  if tg_op = 'DELETE' then
    if old.movement_id is not null then
      select status into v_status from public.movements where id = old.movement_id;
      if found and not public.movement_is_editable(v_status) then
        raise exception 'movement is not editable in status %', v_status using errcode = 'P0001';
      end if;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.movement_id is not null then
      select regime, status into v_regime, v_status from public.movements where id = new.movement_id;
      if not found then
        raise exception 'movement % not found', new.movement_id using errcode = 'P0002';
      end if;
      if v_regime is distinct from new.regime then
        raise exception 'shipment regime % does not match movement regime %', new.regime, v_regime
          using errcode = 'P0001';
      end if;
      if not public.movement_is_editable(v_status) then
        raise exception 'movement is not editable in status %', v_status using errcode = 'P0001';
      end if;
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.regime is distinct from old.regime then
    raise exception 'shipment identity fields are immutable' using errcode = 'P0001';
  end if;

  if new.movement_id is distinct from old.movement_id then
    -- `on delete set null` fires this trigger for every shipment of a deleted
    -- draft movement; that detach is part of the delete, not a re-assignment.
    if new.movement_id is not null
       or exists (select 1 from public.movements where id = old.movement_id) then
      if old.status not in ('draft','rejected') then
        raise exception 'shipment % can only be re-assigned while draft or rejected', old.control_number
          using errcode = 'P0001';
      end if;
      if old.movement_id is not null then
        select status into v_status from public.movements where id = old.movement_id;
        if found and not public.movement_is_editable(v_status) then
          raise exception 'movement is not editable in status %', v_status using errcode = 'P0001';
        end if;
      end if;
      if new.movement_id is not null then
        select regime, status into v_regime, v_status from public.movements where id = new.movement_id;
        if not found then
          raise exception 'movement % not found', new.movement_id using errcode = 'P0002';
        end if;
        if v_regime is distinct from new.regime then
          raise exception 'shipment regime % does not match movement regime %', new.regime, v_regime
            using errcode = 'P0001';
        end if;
        if not public.movement_is_editable(v_status) then
          raise exception 'movement is not editable in status %', v_status using errcode = 'P0001';
        end if;
      end if;
    end if;
    return new;
  end if;

  -- Content edits (everything but the shipment's own lifecycle) are frozen
  -- once the movement carrying it has been transmitted.
  if new.movement_id is not null
     and (to_jsonb(new) - 'status' - 'control_number' - 'entry_on_file_at' - 'released_at'
                        - 'arrived_at' - 'cancelled_at' - 'updated_at')
         is distinct from
         (to_jsonb(old) - 'status' - 'control_number' - 'entry_on_file_at' - 'released_at'
                        - 'arrived_at' - 'cancelled_at' - 'updated_at') then
    select status into v_status from public.movements where id = new.movement_id;
    if found and not public.movement_is_editable(v_status) then
      raise exception 'movement is not editable in status %', v_status using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create trigger shipments_guard
  before insert or update or delete on public.shipments for each row execute function public.shipments_guard();

-- movement_children_guard() — live definition is 0011_schema_gaps.sql:99-120
-- (0011 added the "let a parent cascade through" branch on top of 0003's
-- original body, and that must not be lost here). Rebuilt from that body with
-- only the movement lookup changed: `commodities` no longer carries
-- movement_id, so it resolves through its shipment.
create or replace function public.movement_children_guard()
returns trigger
language plpgsql
as $$
declare
  v_movement_id uuid;
  v_status text;
begin
  if tg_table_name = 'commodities' then
    select s.movement_id into v_movement_id from public.shipments s
      where s.id = coalesce(new.shipment_id, old.shipment_id);
    -- Parent shipment already gone: this row is part of that cascade.
    if not found then
      return coalesce(new, old);
    end if;
    -- An unassigned shipment is on no manifest yet, so nothing is frozen.
    if v_movement_id is null then
      return coalesce(new, old);
    end if;
  else
    v_movement_id := coalesce(new.movement_id, old.movement_id);
  end if;

  select status into v_status from public.movements where id = v_movement_id;
  if v_status is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    raise exception 'movement % not found', v_movement_id using errcode = 'P0002';
  end if;
  if not public.movement_is_editable(v_status) then
    raise exception 'movement is not editable in status %', v_status using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger commodities_editable_guard
  before insert or update or delete on public.commodities for each row execute function public.movement_children_guard();

-- -----------------------------------------------------------------------------
-- 6. RLS
-- -----------------------------------------------------------------------------

alter table public.shipments        enable row level security;
alter table public.commodity_hazmat enable row level security;

-- shipments follow shipment.read / shipment.write; a driver assigned to the
-- movement sees the shipments riding on it, exactly as for commodities/seals.
create policy shipments_select on public.shipments for select to authenticated
  using (
    public.has_permission(organization_id, 'shipment.read')
    or (movement_id is not null and public.is_assigned_movement(movement_id))
  );
create policy shipments_insert on public.shipments for insert to authenticated
  with check (public.has_permission(organization_id, 'shipment.write'));
create policy shipments_update on public.shipments for update to authenticated
  using (public.has_permission(organization_id, 'shipment.write'))
  with check (public.has_permission(organization_id, 'shipment.write'));
-- Only drafts are deletable; anything filed with customs is cancelled, never
-- removed (mirrors movements_delete in 0011).
create policy shipments_delete on public.shipments for delete to authenticated
  using (public.has_permission(organization_id, 'shipment.write') and status = 'draft');

-- commodities keep the cargo_* policies' shape, renamed and re-pointed at the
-- shipment's movement for the driver-portal branch.
create policy commodities_select on public.commodities for select to authenticated
  using (
    public.has_permission(organization_id, 'shipment.read')
    or exists (
      select 1 from public.shipments s
      where s.id = commodities.shipment_id
        and s.movement_id is not null
        and public.is_assigned_movement(s.movement_id)
    )
  );
create policy commodities_modify on public.commodities for all to authenticated
  using (public.has_permission(organization_id, 'shipment.write'))
  with check (public.has_permission(organization_id, 'shipment.write'));

create policy commodity_hazmat_select on public.commodity_hazmat for select to authenticated
  using (public.has_permission(organization_id, 'shipment.read'));
create policy commodity_hazmat_modify on public.commodity_hazmat for all to authenticated
  using (public.has_permission(organization_id, 'shipment.write'))
  with check (public.has_permission(organization_id, 'shipment.write'));

grant select, insert, update, delete on public.shipments, public.commodity_hazmat
  to authenticated, service_role;

-- partners_select's driver-portal branch reached shippers/consignees through
-- cargo; those columns now live on shipments.
create policy partners_select on public.partners for select to authenticated
  using (
    public.has_permission(organization_id, 'partner.read')
    or exists (
      select 1 from public.shipments s
      where (s.shipper_id = partners.id or s.consignee_id = partners.id)
        and s.movement_id is not null
        and public.is_assigned_movement(s.movement_id)
    )
  );
