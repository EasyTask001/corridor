-- =============================================================================
-- Corridor — 0013 usage metering + job-lease reclaim
--
--   1. usage_records — per-organization meter of the billable events the app
--      already performs (document extractions, copilot messages, customs
--      transmissions, AI suggestions). Rows are written through the
--      SECURITY DEFINER record_usage(); authenticated has SELECT only, gated
--      on billing.manage, so a tenant can read its own meter and nobody
--      else's, and nobody can forge a row.
--   2. claim_jobs() gains a lease: a job left `running` by a worker that
--      crashed mid-flight is claimable again after p_lease_seconds, so a dead
--      worker cannot hold one of an organization's cap slots forever.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. usage_records
--    period_start is the first day of the calendar month (UTC) that
--    occurred_at falls in — the grain the billing UI and Stripe meters use.
--    stripe_meter_event_id / reported_at are stamped by the
--    `billing.report_usage` worker job once the event reaches Stripe (or a
--    synthetic id in mock mode); null means "not reported yet".
-- -----------------------------------------------------------------------------

create table public.usage_records (
  id                    bigint generated always as identity primary key,
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  metric                text not null check (metric in (
                          'documents_extracted',
                          'copilot_messages',
                          'movements_transmitted',
                          'ai_suggestions'
                        )),
  quantity              int not null default 1 check (quantity > 0),
  occurred_at           timestamptz not null default now(),
  period_start          date not null,
  stripe_meter_event_id text,
  reported_at           timestamptz,
  metadata              jsonb not null default '{}'::jsonb
);

-- Backs the per-period usage roll-up on the billing page.
create index usage_records_org_period_metric_idx
  on public.usage_records (organization_id, period_start, metric);

-- Backs the reporter job's "everything still unreported, oldest first" scan.
create index usage_records_unreported_idx
  on public.usage_records (occurred_at)
  where reported_at is null;

-- -----------------------------------------------------------------------------
-- record_usage — the only write path open to a browser session.
--
-- SECURITY DEFINER (so it can insert into a table `authenticated` may only
-- read) and therefore re-checks membership itself, exactly like log_audit.
--
-- The membership check is conditional on there being a JWT at all: the same
-- meter is written by the background worker, which runs under the service role
-- in a transaction with no request.jwt.claims and hence no auth.uid(). Any
-- browser-reachable caller always carries a JWT (withRls sets the claims before
-- handing the transaction to application code), so that path is always checked.
-- EXECUTE is revoked from anon, so an unauthenticated caller cannot reach it.
-- -----------------------------------------------------------------------------

create or replace function public.record_usage(
  p_org uuid,
  p_metric text,
  p_qty int default 1,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id       bigint;
  v_occurred timestamptz := now();
begin
  if (select auth.uid()) is not null and not public.is_org_member(p_org) then
    raise exception 'not a member of organization %', p_org using errcode = '42501';
  end if;

  insert into public.usage_records (
    organization_id, metric, quantity, occurred_at, period_start, metadata
  )
  values (
    p_org,
    p_metric,
    coalesce(p_qty, 1),
    v_occurred,
    (date_trunc('month', v_occurred at time zone 'utc'))::date,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS + grants. Reads are gated on billing.manage (the same permission that
-- may change the plan the usage is billed against); every write goes through
-- record_usage() or the service role.
-- -----------------------------------------------------------------------------

alter table public.usage_records enable row level security;

create policy usage_records_select on public.usage_records
  for select to authenticated
  using (public.has_permission(organization_id, 'billing.manage'));

grant select, insert, update, delete on public.usage_records to service_role;
grant select on public.usage_records to authenticated;
revoke insert, update, delete on public.usage_records from authenticated;

revoke execute on function public.record_usage(uuid, text, int, jsonb) from public, anon;
grant execute on function public.record_usage(uuid, text, int, jsonb)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. claim_jobs() — stale-lease reclaim.
--
-- 0011 added the per-organization concurrency cap. A worker that dies between
-- claiming a job and finishing it leaves the row in `running` with a stale
-- locked_at, permanently consuming one of that organization's cap slots and
-- stranding the job. Treat such a row as claimable again once its lease has
-- expired: it is re-claimed like a pending job (attempts incremented), and
-- max_attempts still bounds the retries so a job that reliably kills its
-- worker is not retried forever.
--
-- The 3-argument overload is dropped rather than replaced: keeping both would
-- make every existing 2-argument call site ambiguous.
-- -----------------------------------------------------------------------------

drop function if exists public.claim_jobs(int, text, int);

create or replace function public.claim_jobs(
  p_limit int default 10,
  p_worker text default 'worker',
  p_org_cap int default 2,
  p_lease_seconds int default 600
)
returns setof public.background_jobs
language sql
security definer
set search_path = public
as $$
  with stale as (
    -- running, but its worker has not been heard from within the lease
    select j.id
    from public.background_jobs j
    where j.status = 'running'
      and j.locked_at is not null
      and j.locked_at < now() - make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 0))
      and j.attempts < j.max_attempts
  ),
  running as (
    -- a stale row is being reclaimed, so it no longer occupies a cap slot
    select j.organization_id, count(*)::int as running_count
    from public.background_jobs j
    where j.status = 'running'
      and j.organization_id is not null
      and not exists (select 1 from stale where stale.id = j.id)
    group by j.organization_id
  ),
  claimable as (
    select j.id, j.organization_id, j.run_at
    from public.background_jobs j
    where (j.status = 'pending' and j.run_at <= now())
       or exists (select 1 from stale where stale.id = j.id)
  ),
  ranked as (
    select
      c.id,
      c.organization_id,
      row_number() over (partition by c.organization_id order by c.run_at, c.id) as rn
    from claimable c
  ),
  eligible as (
    select ranked.id
    from ranked
    left join running on running.organization_id = ranked.organization_id
    where ranked.organization_id is null
       or coalesce(running.running_count, 0) + ranked.rn <= p_org_cap
  ),
  due as (
    select b.id from public.background_jobs b
    where b.id in (select eligible.id from eligible)
    order by b.run_at, b.id
    for update skip locked
    limit p_limit
  )
  update public.background_jobs j
  set status = 'running',
      attempts = j.attempts + 1,
      locked_at = now(),
      locked_by = p_worker,
      started_at = coalesce(j.started_at, now())
  from due
  where j.id = due.id
  returning j.*;
$$;

revoke execute on function public.claim_jobs(int, text, int, int) from public, anon, authenticated;
grant execute on function public.claim_jobs(int, text, int, int) to service_role;
