-- Corridor — 0047 BorderConnect service-provider mode: widen `mode` to
-- border_connect, an org's BorderConnect company key, truck conveyance type,
-- the shared customs_inbox, and the background_jobs_insert rebuild that
-- allow-lists customs.borderconnect_drain to the service role only.
--
--   1. integration_configs.mode / customs_submissions.mode gain 'border_connect'
--      alongside 'mock' and 'gateway' (0023) — BorderConnect is a third filing
--      mode, same grain as the existing two.
--   2. organizations.border_connect_company_key: the account key BorderConnect
--      issues per carrier, one-to-one with the org like scac_code /
--      canadian_carrier_code (0001) — a column, not a table.
--   3. trucks.truck_type: the BorderConnect/CBP conveyance type code
--      (truck-types.json), same grain as the rest of trucks — a column.
--   4. customs_inbox: see the table's own header below.
--   5. background_jobs_insert is rebuilt (live definition is 0025) to
--      allow-list customs.borderconnect_drain, enqueued only by the cron
--      route under the service role — no session may enqueue it.

-- -----------------------------------------------------------------------------
-- 1. integration_configs / customs_submissions (same grain — widen the check)
-- -----------------------------------------------------------------------------

alter table public.integration_configs drop constraint integration_configs_mode_check,
  add constraint integration_configs_mode_check check (mode in ('mock','gateway','border_connect'));
alter table public.customs_submissions drop constraint customs_submissions_mode_check,
  add constraint customs_submissions_mode_check check (mode in ('mock','gateway','border_connect'));

-- -----------------------------------------------------------------------------
-- 2. organizations (one-to-one with scac_code / canadian_carrier_code → column)
-- -----------------------------------------------------------------------------

alter table public.organizations
  add column border_connect_company_key text
    check (char_length(border_connect_company_key) between 1 and 64);
create unique index organizations_border_connect_company_key_key
  on public.organizations (border_connect_company_key)
  where border_connect_company_key is not null;   -- query: inbox routing by companyKey

-- -----------------------------------------------------------------------------
-- 3. trucks (same grain — column): BorderConnect/CBP conveyance type, truck-types.json
-- -----------------------------------------------------------------------------

alter table public.trucks
  add column truck_type text not null default 'TR' check (truck_type ~ '^[A-Z]{2}$');

-- -----------------------------------------------------------------------------
-- 4. customs_inbox
-- -----------------------------------------------------------------------------

-- Why a new table: the grain is one inbound message from a provider's SHARED
-- queue, received before its tenant is known. integration_events was
-- considered: organization_id is not null there, its grain is one HTTP call,
-- and it is append-only — an unroutable message has no organization yet and a
-- row here is updated when it is processed. customs_submissions was considered:
-- one row per outbound filing; a filing receives many messages and some
-- messages (SYSTEM_ALERT, RNS_SHIPMENT) belong to no filing. background_jobs
-- was considered: a job is a unit of work, not a record that must survive it.
create table public.customs_inbox (
  id                       bigint generated always as identity primary key,
  organization_id          uuid references public.organizations(id) on delete cascade,
  provider                 text not null default 'border_connect' check (provider in ('border_connect')),
  company_key              text,
  data_type                text not null,
  send_id                  text,
  trip_number              text,
  cargo_control_number     text,
  shipment_control_number  text,
  payload                  jsonb not null,
  payload_sha256           text not null unique,        -- dedup: HTTP retries / socket + poll overlap
  received_at              timestamptz not null default now(),
  processed_at             timestamptz,
  processing_error         text,
  movement_id              uuid,
  customs_submission_id    uuid,
  constraint customs_inbox_movement_org_fkey foreign key (movement_id, organization_id)
    references public.movements(id, organization_id) on delete set null,
  constraint customs_inbox_submission_org_fkey foreign key (customs_submission_id, organization_id)
    references public.customs_submissions(id, organization_id) on delete set null
);
create index customs_inbox_unprocessed_idx on public.customs_inbox (id) where processed_at is null; -- drain
create index customs_inbox_org_received_idx on public.customs_inbox (organization_id, received_at desc)
  where organization_id is not null;                                                              -- settings page list
create index customs_inbox_trip_number_idx on public.customs_inbox (trip_number)
  where trip_number is not null;                                                                   -- Settings inbox search
create index customs_inbox_cargo_control_number_idx on public.customs_inbox (cargo_control_number)
  where cargo_control_number is not null;                                                           -- Settings inbox search
alter table public.customs_inbox enable row level security;
create policy customs_inbox_select on public.customs_inbox for select to authenticated
  using (organization_id is not null and public.has_permission(organization_id, 'integrations.manage'));
revoke all on public.customs_inbox from anon, authenticated;
grant select on public.customs_inbox to authenticated;
grant all on public.customs_inbox to service_role;

-- -----------------------------------------------------------------------------
-- 5. background_jobs_insert — live definition is 0025. Rebuilt with
--    customs.borderconnect_drain, enqueued only by the cron route under the
--    service role.
-- -----------------------------------------------------------------------------

drop policy background_jobs_insert on public.background_jobs;
create policy background_jobs_insert on public.background_jobs for insert to authenticated
  with check (
    organization_id is not null and case job_type
      when 'customs.decide' then public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'customs.poll_status' then public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'customs.notices_sync' then false
      when 'customs.borderconnect_drain' then false
      when 'driver.notify' then public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'compliance.scan' then public.has_permission(organization_id, 'alert.manage')
      when 'document.extract' then public.has_permission(organization_id, 'document.upload')
      when 'copilot.embed_knowledge' then case payload ->> 'sourceType'
        when 'movement_note' then public.has_permission(organization_id, 'movement.write')
        when 'hold_resolution' then public.has_permission(organization_id, 'alert.manage')
        when 'sop_document' then public.has_permission(organization_id, 'document.upload')
        else false end
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
