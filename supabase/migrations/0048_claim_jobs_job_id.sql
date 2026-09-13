-- Corridor — 0048 add a job-id filter to claim_jobs
--
-- Why: `customs.borderconnect_drain` is a queue-wide job (organization_id is
-- null — see 0047), so `p_organization_id` cannot scope a claim to just that
-- job. Two callers need exactly that scope: the Settings "Test connection"
-- button (packages/api/src/router/integrations.ts `testCustoms`) and the
-- every-minute cron (apps/web/src/app/api/jobs/borderconnect-drain/route.ts)
-- both enqueue their own drain job and then call `processDueJobs` with no
-- organization filter — which, before this migration, could claim and
-- execute up to `p_limit` due jobs belonging to ANY tenant, not just the
-- drain job either caller just enqueued. Adding `p_job_id` lets both callers
-- claim exactly the one job they enqueued.
--
-- `drop function` first, not `create or replace`: adding a parameter changes
-- the signature, and Postgres would keep both the 5-arg and 6-arg overloads
-- resolvable, which `packages/db/src/jobs.integration.test.ts`'s "exactly
-- one claim_jobs overload" check (added in 0041) exists specifically to
-- catch.

drop function public.claim_jobs(int, text, int, int, uuid);

create or replace function public.claim_jobs(
  p_limit int default 10,
  p_worker text default 'worker',
  p_org_cap int default 2,
  p_lease_seconds int default 600,
  p_organization_id uuid default null,
  p_job_id bigint default null
)
returns setof public.background_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 0));
begin
  -- Retire stale claims that have used up their attempts (0033), scoped like
  -- the claim itself so a tenant- or job-scoped run touches only its own row.
  update public.background_jobs
  set status = 'failed', finished_at = now(), locked_at = null, locked_by = null,
      lease_token = null, lease_expires_at = null,
      last_error = coalesce(last_error, 'lease expired after max attempts')
  where status = 'running' and lease_expires_at < now() and attempts >= max_attempts
    and (p_organization_id is null or organization_id = p_organization_id)
    and (p_job_id is null or id = p_job_id);

  return query
  with running as (
    -- Queue-wide on purpose: the per-org cap counts everything the org has
    -- running, whoever claimed it.
    select organization_id, count(*)::int as running_count
    from public.background_jobs
    where status = 'running' and organization_id is not null
      and lease_expires_at >= now()
    group by organization_id
  ), candidates as (
    select j.id, j.organization_id, j.run_at,
           row_number() over (
             partition by j.organization_id
             order by j.run_at, j.id
           ) as org_rank
    from public.background_jobs j
    where ((j.status = 'pending' and j.run_at <= now())
       or (j.status = 'running' and j.lease_expires_at < now() and j.attempts < j.max_attempts))
      and (p_organization_id is null or j.organization_id = p_organization_id)
      and (p_job_id is null or j.id = p_job_id)
  ), eligible as (
    -- A candidate is admitted only if its rank within the organization fits
    -- inside the org's remaining headroom for THIS batch — not just whether
    -- the org was under cap before the batch started.
    select c.id
    from candidates c
    left join running r on r.organization_id = c.organization_id
    where c.organization_id is null
       or c.org_rank <= (p_org_cap - coalesce(r.running_count, 0))
  ), due as (
    select j.id
    from public.background_jobs j
    where j.id in (select id from eligible)
      -- Re-checked here, at lock time, against the latest row version: a row
      -- that was still a candidate when `candidates` was computed may already
      -- have been claimed and committed by a concurrent worker by the time
      -- this scan locks it.
      and ((j.status = 'pending' and j.run_at <= now())
        or (j.status = 'running' and j.lease_expires_at < now() and j.attempts < j.max_attempts))
    order by j.run_at, j.id
    for update of j skip locked
    limit p_limit
  )
  update public.background_jobs j
  set status = 'running', attempts = j.attempts + 1, locked_at = now(), locked_by = p_worker,
      lease_token = gen_random_uuid(), lease_expires_at = now() + v_lease,
      started_at = coalesce(j.started_at, now())
  from due where j.id = due.id
  returning j.*;
end;
$$;

revoke execute on function public.claim_jobs(int, text, int, int, uuid, bigint) from public, anon, authenticated;
grant execute on function public.claim_jobs(int, text, int, int, uuid, bigint) to service_role;
