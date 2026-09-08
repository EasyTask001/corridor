-- =============================================================================
-- Corridor — 0027 PARS RNS feed and the gated public PAPS/PARS lookup (Avaal
-- parity gaps 2 (RNS) and 17)
--
--   1. public.pars_rns_events — CBSA Release Notification System messages for
--      PARS shipments (release code, office, sub-location, transaction and
--      container numbers), one row per message.
--   2. public.lookup_shipment_status() — the single, minimal read the public
--      tracking page is allowed: status, port, entry number and timestamps for
--      one carrier code + control number, executable by service_role only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. pars_rns_events
--
-- Why a new table: the grain is one RNS message CBSA sent about a PARS
-- shipment. `movement_events` was considered — a `customs_event` row records
-- the same moment on the movement timeline — but the RNS feed is queried by
-- PARS number and release code across movements (Avaal's "PARS RNS" screen),
-- carries CBSA-specific fields that are not on any other message (office,
-- sub-location, transaction and container numbers), and may arrive for a
-- shipment that is not on a movement at all. A typed table beats a jsonb
-- payload filter on the timeline.
-- -----------------------------------------------------------------------------

create table public.pars_rns_events (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  shipment_id        uuid references public.shipments(id) on delete set null,
  pars_number        text not null,
  release_code       text,
  released_at        timestamptz,
  office_code        text,
  sublocation_code   text,
  transaction_number text,
  container_number   text,
  raw                jsonb,
  received_at        timestamptz not null default now()
);

create index pars_rns_events_organization_id_idx on public.pars_rns_events (organization_id);
create index pars_rns_events_org_received_idx on public.pars_rns_events (organization_id, received_at desc);
create index pars_rns_events_pars_idx on public.pars_rns_events (pars_number);

create trigger pars_rns_events_append_only
  before update or delete on public.pars_rns_events for each row execute function public.reject_modification();

alter table public.pars_rns_events enable row level security;

create policy pars_rns_events_select on public.pars_rns_events for select to authenticated
  using (public.has_permission(organization_id, 'shipment.read'));
-- Written by applyCustomsDecision: from the dev simulation under a session that
-- may transmit, or by the worker / webhook under the service role.
create policy pars_rns_events_insert on public.pars_rns_events for insert to authenticated
  with check (public.has_permission(organization_id, 'movement.transmit_to_customs'));

grant select, insert on public.pars_rns_events to authenticated;
grant select, insert, update, delete on public.pars_rns_events to service_role;

-- -----------------------------------------------------------------------------
-- 2. lookup_shipment_status(carrier code, control number)
--
-- The public tracking page answers "where is my PAPS/PARS" for a driver or a
-- broker who knows the carrier code and the control number. It runs as
-- SECURITY DEFINER because there is no session; it is granted to service_role
-- only, so a browser session can never call it; and it returns nothing but the
-- status, the port, the entry number and the timestamps — never the
-- organization, driver, truck or commodities.
-- -----------------------------------------------------------------------------

create or replace function public.lookup_shipment_status(p_carrier_code text, p_control_number text)
returns table (
  status       text,
  port_code    text,
  port_name    text,
  entry_number text,
  updated_at   timestamptz,
  released_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select s.status,
         p.code  as port_code,
         p.name  as port_name,
         s.entry_number,
         s.updated_at,
         s.released_at
  from public.shipments s
  left join public.movements m on m.id = s.movement_id
  left join public.ports p on p.id = m.port_id
  where s.carrier_code = upper(p_carrier_code)
    and s.control_number = upper(p_control_number)
  order by s.updated_at desc
  limit 1;
$$;

revoke all on function public.lookup_shipment_status(text, text) from public;
revoke all on function public.lookup_shipment_status(text, text) from anon, authenticated;
grant execute on function public.lookup_shipment_status(text, text) to service_role;
