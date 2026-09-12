-- Corridor — 0045 fix claim_jobs' per-organization cap within one batch
--
-- 0033/0041's `due` CTE checked each candidate row against a `running_count`
-- computed once, before the batch's own claims are applied. Every pending (or
-- reclaimable) row for an organization independently passed
-- `coalesce(running_count, 0) < p_org_cap`, since none of them had been
-- marked `running` yet at CTE-evaluation time — so a single claim_jobs() call
-- could claim every due row for an organization in one shot, ignoring the
-- cap entirely. Found while fixing the `packages/db/src/jobs.integration.test.ts`
-- lease fixtures: with the lease bug fixed, "a stale job does not consume one
-- of its organization's cap slots" and "caps how many jobs one organization
-- may have running at once" still over-claimed (3 rows instead of 2).
--
-- Fix: rank each organization's candidates by (run_at, id) and admit only as
-- many as the organization has remaining headroom (p_org_cap - already
-- running), so the cap holds within a single batch, not just across calls.
--
-- The claimability predicate (status/run_at/lease) is repeated in the final
-- locking CTE rather than only upstream: Postgres only re-validates a row
-- against a WHERE predicate at FOR UPDATE lock time when that predicate is
-- evaluated in the same scan as the lock (EvalPlanQual) — the exact
-- concurrency guarantee 0013's comment on this function describes. A first
-- draft of this fix computed eligibility once upstream and joined it into
-- the locking CTE by id only, which reopened that race under the
-- "under heavy contention no job is ever claimed twice" test.

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

revoke execute on function public.claim_jobs(int, text, int, int, uuid) from public, anon, authenticated;
grant execute on function public.claim_jobs(int, text, int, int, uuid) to service_role;
