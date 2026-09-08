-- =============================================================================
-- Corridor — 0026 in-bond monitor and external shipments (Avaal parity gaps
-- 11 and 12)
--
--   1. public.external_shipments — goods another carrier filed, that this
--      carrier only moves in-bond (Avaal's "external shipments").
--   2. public.in_bond_records — one in-bond move (IT / TE / IE) with its bond
--      number, arrival and export ports and FIRMS code, for one of our
--      shipments or an external one.
--   3. public.in_bond_events — what was sent to and heard from customs about
--      that move.
--   Permissions inbond.read / inbond.write are added to the catalogue by the
--   generated seed.sql (packages/domain/src/permission.ts).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. external_shipments
--
-- Why a new table: the grain is a shipment somebody else filed (its SCN /
-- bill of lading or in-bond number belongs to the originating carrier) that
-- this carrier moves under bond without ever filing it itself. `shipments`
-- was considered — its grain is a filing of ours: carrier code + control
-- reference unique per organization, a regime-typed ACE shipment type or ACI
-- cargo type, and the customs lifecycle from draft through released. An
-- external shipment has none of that: no filing, no type, just the other
-- carrier's identifiers and an open/closed monitor state. Different grain
-- and lifecycle, so a table of its own.
-- -----------------------------------------------------------------------------

create table public.external_shipments (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  regime                   text not null check (regime in ('ACE','ACI')),
  -- The originating carrier's control number (SCN / bill), and/or the bond.
  control_number           text check (control_number ~ '^[A-Z0-9]{4,24}$'),
  in_bond_number           text check (in_bond_number ~ '^\d{9}$'),
  originating_carrier_code text check (originating_carrier_code ~ '^[A-Z0-9]{2,4}$'),
  description              text,
  status                   text not null default 'open' check (status in ('open','closed')),
  created_by               uuid references auth.users(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint external_shipments_identity_check
    check (control_number is not null or in_bond_number is not null)
);

create index external_shipments_organization_id_idx on public.external_shipments (organization_id);
create index external_shipments_org_status_idx on public.external_shipments (organization_id, status);

create trigger external_shipments_set_updated_at
  before update on public.external_shipments for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. in_bond_records
--
-- Why a new table: the grain is one in-bond move — the bond CBP issued, the
-- port it arrives at, the port it exports from and the bonded warehouse
-- (FIRMS) — with its own arrival → export lifecycle that customs answers
-- separately from the manifest. `shipments` already carries the in-bond
-- entry type, destination and number as filing data, but a move outlives the
-- manifest (the arrival and export messages are sent days later, after the
-- movement is released or arrived) and exists for external shipments that
-- have no `shipments` row at all. Same fields would otherwise be duplicated
-- onto two parents; a child with an exactly-one-parent check keeps one grain.
-- -----------------------------------------------------------------------------

create table public.in_bond_records (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  shipment_id            uuid references public.shipments(id) on delete cascade,
  external_shipment_id   uuid references public.external_shipments(id) on delete cascade,
  -- Assigned by CBP; null until the bond is on file.
  bond_number            text check (bond_number ~ '^\d{9}$'),
  entry_type             text not null check (entry_type in ('IT','TE','IE')),
  arrival_port_id        uuid references public.ports(id),
  export_port_id         uuid references public.ports(id),
  -- Bonded facility (Facilities Information and Resources Management System).
  firms_code             text check (firms_code ~ '^[A-Z0-9]{4}$'),
  status                 text not null default 'open'
                           check (status in ('open','arrival_sent','arrived','export_sent','exported','cancelled')),
  last_status_checked_at timestamptz,
  created_by             uuid references auth.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint in_bond_records_parent_check
    check ((shipment_id is null) <> (external_shipment_id is null))
);

create index in_bond_records_organization_id_idx on public.in_bond_records (organization_id);
create index in_bond_records_org_status_idx on public.in_bond_records (organization_id, status);
-- One move per shipment, one per external shipment.
create unique index in_bond_records_shipment_unique on public.in_bond_records (shipment_id)
  where shipment_id is not null;
create unique index in_bond_records_external_unique on public.in_bond_records (external_shipment_id)
  where external_shipment_id is not null;
create index in_bond_records_bond_idx on public.in_bond_records (bond_number)
  where bond_number is not null;

create trigger in_bond_records_set_updated_at
  before update on public.in_bond_records for each row execute function public.set_updated_at();

-- Bond number and parent: the identity of a move never changes. `status`
-- moves only forward through the lifecycle the domain table defines.
create or replace function public.in_bond_records_guard()
returns trigger
language plpgsql
as $$
begin
  if new.shipment_id is distinct from old.shipment_id
     or new.external_shipment_id is distinct from old.external_shipment_id
     or new.organization_id is distinct from old.organization_id then
    raise exception 'in-bond record parent is immutable' using errcode = 'P0001';
  end if;
  if old.bond_number is not null and new.bond_number is distinct from old.bond_number then
    raise exception 'in-bond number is immutable once assigned' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'open'         and new.status in ('arrival_sent','cancelled'))
    or (old.status = 'arrival_sent' and new.status in ('arrived','open','cancelled'))
    or (old.status = 'arrived'      and new.status in ('export_sent','cancelled'))
    or (old.status = 'export_sent'  and new.status in ('exported','arrived','cancelled'))
  ) then
    raise exception 'invalid in-bond transition % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger in_bond_records_guard
  before update on public.in_bond_records for each row execute function public.in_bond_records_guard();

-- -----------------------------------------------------------------------------
-- 3. in_bond_events
--
-- Why a new table: the grain is one message about one in-bond move — sent
-- (arrival, export, cancel, status request) or received (customs response,
-- a note). `movement_events` was considered: its grain is the movement, and
-- an external shipment's move has no movement; `integration_events` logs the
-- HTTP call itself, is readable only with integrations.manage and carries no
-- record id. Append-only, like movement_events.
-- -----------------------------------------------------------------------------

create table public.in_bond_events (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  in_bond_record_id uuid not null references public.in_bond_records(id) on delete cascade,
  kind              text not null check (kind in
                      ('arrival_sent','export_sent','cancel_sent','status_requested','customs_response','note')),
  actor_type        text not null check (actor_type in ('user','system','customs_api')),
  actor_id          uuid references auth.users(id) on delete set null,
  payload           jsonb,
  occurred_at       timestamptz not null default now()
);

create index in_bond_events_organization_id_idx on public.in_bond_events (organization_id);
create index in_bond_events_record_idx on public.in_bond_events (in_bond_record_id, occurred_at desc);

-- Rows are never edited; deletion only ever happens through the cascade from
-- the record (a session holds no delete grant), so the trigger guards update.
create trigger in_bond_events_append_only
  before update on public.in_bond_events for each row execute function public.reject_modification();

-- -----------------------------------------------------------------------------
-- 4. RLS
-- -----------------------------------------------------------------------------

alter table public.external_shipments enable row level security;
alter table public.in_bond_records    enable row level security;
alter table public.in_bond_events     enable row level security;

create policy external_shipments_select on public.external_shipments for select to authenticated
  using (public.has_permission(organization_id, 'inbond.read'));
create policy external_shipments_modify on public.external_shipments for all to authenticated
  using (public.has_permission(organization_id, 'inbond.write'))
  with check (public.has_permission(organization_id, 'inbond.write'));

create policy in_bond_records_select on public.in_bond_records for select to authenticated
  using (public.has_permission(organization_id, 'inbond.read'));
create policy in_bond_records_modify on public.in_bond_records for all to authenticated
  using (public.has_permission(organization_id, 'inbond.write'))
  with check (public.has_permission(organization_id, 'inbond.write'));

create policy in_bond_events_select on public.in_bond_events for select to authenticated
  using (public.has_permission(organization_id, 'inbond.read'));
create policy in_bond_events_insert on public.in_bond_events for insert to authenticated
  with check (public.has_permission(organization_id, 'inbond.write'));

grant select, insert, update, delete on public.external_shipments, public.in_bond_records
  to authenticated, service_role;
grant select, insert on public.in_bond_events to authenticated;
grant select, insert, update, delete on public.in_bond_events to service_role;
