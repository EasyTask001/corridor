-- =============================================================================
-- Corridor — 0023 customs gateway: live filing mode, submissions audit,
-- carrier notices, status polling (Avaal parity gaps 1 and 16)
--
--   1. integration_configs: `mode` (mock | gateway), the gateway base URL and
--      the last poll time.
--   2. public.customs_submissions — every outbound call to a customs gateway
--      (original, amendment, cancel, in-bond), keyed by the gateway's
--      reference number so an inbound webhook can find its movement.
--   3. public.carrier_notices — CBP/CBSA service notices, global.
--   4. background_jobs_insert allow-lists the two new job types.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. integration_configs (same grain — columns)
-- -----------------------------------------------------------------------------

alter table public.integration_configs
  -- `mock` keeps today's deterministic gateway; `gateway` files through the
  -- certified EDI gateway's REST API (or its fixture replay when no base URL
  -- and API key are configured).
  add column mode           text not null default 'mock' check (mode in ('mock','gateway')),
  add column base_url       text check (base_url ~ '^https?://'),
  add column last_polled_at timestamptz;

-- -----------------------------------------------------------------------------
-- 2. customs_submissions
--
-- Why a new table: the grain is one manifest filing (original, amendment,
-- cancellation or in-bond message) as the gateway knows it — with the
-- reference number it assigned and a status that moves as acknowledgements
-- and decisions come back. `integration_events` was considered: it logs one
-- row per HTTP call, but it is append-only (its rows never change once
-- written), readable only with `integrations.manage`, and carries no
-- reference number to look a filing up by; a filing is read by dispatchers
-- (`movement.read`), is updated when the gateway answers, and is the key an
-- inbound webhook resolves to an organization and a movement. Lifecycle and
-- RLS both differ, so it gets its own table (CONTRIBUTING → Schema design:
-- one-to-one → columns unless RLS or lifecycle differ).
-- -----------------------------------------------------------------------------

create table public.customs_submissions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  -- Null for an in-bond message about an external shipment (Task 9).
  movement_id      uuid references public.movements(id) on delete cascade,
  kind             text not null check (kind in ('original','amendment','cancel','in_bond')),
  provider         text not null check (provider in ('cbp_ace','cbsa_aci')),
  -- `mock` or `gateway` at the time of the call, so a fixture reply is never
  -- mistaken for a real one in the audit.
  mode             text not null check (mode in ('mock','gateway')),
  reference_number text,
  correlation_id   text,
  status           text not null default 'sent'
                     check (status in ('sent','acknowledged','failed','accepted','rejected','released','held','cancelled')),
  request          jsonb,
  response         jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index customs_submissions_organization_id_idx on public.customs_submissions (organization_id);
create index customs_submissions_movement_idx on public.customs_submissions (movement_id, created_at desc)
  where movement_id is not null;
create index customs_submissions_reference_idx on public.customs_submissions (reference_number)
  where reference_number is not null;

create trigger customs_submissions_set_updated_at
  before update on public.customs_submissions for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. carrier_notices
--
-- Why a new table: a global reference list, like `ports` and
-- `equipment_types` — the grain is one service notice CBP or CBSA published
-- (outage, cut-over, port closure), identified by the gateway's external id.
-- `notifications` was considered: it is per-recipient (one row per member,
-- with read state) and tenant-scoped; the notice itself belongs to no
-- organization and is fanned out to every org with an enabled config through
-- `notify_organization`. No tenant table has the "one published notice" grain.
-- -----------------------------------------------------------------------------

create table public.carrier_notices (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null check (provider in ('cbp_ace','cbsa_aci')),
  external_id  text not null unique,
  severity     text not null default 'info' check (severity in ('info','warning','critical')),
  title        text not null,
  body         text,
  starts_at    timestamptz,
  ends_at      timestamptz,
  published_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index carrier_notices_published_idx on public.carrier_notices (published_at desc);

-- -----------------------------------------------------------------------------
-- 4. background_jobs_insert — live definition is 0016_notification_push_job.sql
-- (0008 introduced the allow-list; 0016 added notification.push). Rebuilt with
-- the two new producers: customs.poll_status is enqueued by transmit, so it
-- follows movement.transmit_to_customs; customs.notices_sync is enqueued only
-- by the cron route under the service role, never by a session.
-- -----------------------------------------------------------------------------

drop policy background_jobs_insert on public.background_jobs;
create policy background_jobs_insert on public.background_jobs for insert to authenticated
  with check (
    organization_id is not null and case job_type
      when 'customs.decide' then
        public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'customs.poll_status' then
        public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'customs.notices_sync' then false
      when 'compliance.scan' then public.has_permission(organization_id, 'alert.manage')
      when 'document.extract' then public.has_permission(organization_id, 'document.upload')
      when 'copilot.embed_knowledge' then case payload ->> 'sourceType'
        when 'movement_note' then public.has_permission(organization_id, 'movement.write')
        when 'hold_resolution' then public.has_permission(organization_id, 'alert.manage')
        when 'sop_document' then public.has_permission(organization_id, 'document.upload')
        else false
      end
      -- Any member may enqueue this, because the payload is not a message: it
      -- carries only the ids of notification rows, and the worker re-reads the
      -- text and the recipient from `notifications` (scoped to this same
      -- organization). The worst a forged job can do is re-push a colleague's
      -- existing notification inside the caller's own org, which the
      -- integration_events row records.
      when 'notification.push' then public.is_org_member(organization_id)
      else false
    end
  );

-- -----------------------------------------------------------------------------
-- 5. RLS
-- -----------------------------------------------------------------------------

alter table public.customs_submissions enable row level security;
alter table public.carrier_notices     enable row level security;

-- A filing is read by whoever can read the movement; written (and its status
-- moved) by whoever may transmit. Never deleted from a session.
create policy customs_submissions_select on public.customs_submissions for select to authenticated
  using (public.has_permission(organization_id, 'movement.read'));
create policy customs_submissions_insert on public.customs_submissions for insert to authenticated
  with check (public.has_permission(organization_id, 'movement.transmit_to_customs'));
create policy customs_submissions_update on public.customs_submissions for update to authenticated
  using (public.has_permission(organization_id, 'movement.transmit_to_customs'))
  with check (public.has_permission(organization_id, 'movement.transmit_to_customs'));

create policy carrier_notices_select on public.carrier_notices for select to authenticated
  using (true);

grant select, insert, update on public.customs_submissions to authenticated;
grant select, insert, update, delete on public.customs_submissions to service_role;
grant select on public.carrier_notices to authenticated;
grant select, insert, update, delete on public.carrier_notices to service_role;
