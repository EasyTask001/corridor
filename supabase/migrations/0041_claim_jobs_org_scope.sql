-- Corridor — 0041 claim_jobs(p_organization_id) (ISSUE-001)
--
-- integrations.jobs.runNow lets a signed-in user with integrations.manage
-- trigger the worker. The worker claims under the service role, so until now
-- that button drained every tenant's queue and echoed each job's result
-- payload back to the caller. A fifth parameter narrows the claim to one
-- organization; the cron / request-tail workers pass null and behave exactly
-- as in 0033.
--
-- The 4-argument function is dropped rather than overloaded: with defaults on
-- every argument, two overloads would make claim_jobs(5, 'w', 1000) ambiguous.

drop function if exists public.claim_jobs(int, text, int, int);

create or replace function public.claim_jobs(
  p_limit int default 10,
  p_worker text default 'worker',
  p_org_cap int default 2,
  p_lease_seconds int default 600,
  p_organization_id uuid default null
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
  -- the claim itself so a tenant-triggered run touches only its own rows.
  update public.background_jobs
  set status = 'failed', finished_at = now(), locked_at = null, locked_by = null,
      lease_token = null, lease_expires_at = null,
      last_error = coalesce(last_error, 'lease expired after max attempts')
  where status = 'running' and lease_expires_at < now() and attempts >= max_attempts
    and (p_organization_id is null or organization_id = p_organization_id);

  return query
  with running as (
    -- Queue-wide on purpose: the per-org cap counts everything the org has
    -- running, whoever claimed it.
    select organization_id, count(*)::int as running_count
    from public.background_jobs
    where status = 'running' and organization_id is not null
      and lease_expires_at >= now()
    group by organization_id
  ), due as (
    select j.id
    from public.background_jobs j
    left join running r on r.organization_id = j.organization_id
    where ((j.status = 'pending' and j.run_at <= now())
       or (j.status = 'running' and j.lease_expires_at < now() and j.attempts < j.max_attempts))
      and (j.organization_id is null or coalesce(r.running_count, 0) < p_org_cap)
      and (p_organization_id is null or j.organization_id = p_organization_id)
    order by j.run_at, j.id
    for update skip locked
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

revoke execute on function public.claim_jobs(int, text, int, int, uuid) from public, anon, authenticated;
grant execute on function public.claim_jobs(int, text, int, int, uuid) to service_role;
