alter table public.background_jobs
  add column if not exists idempotency_key text,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz;

create unique index if not exists background_jobs_org_idempotency_unique
  on public.background_jobs (organization_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists background_jobs_lease_expiry_idx
  on public.background_jobs (lease_expires_at)
  where status = 'running' and lease_expires_at is not null;

create or replace function public.claim_jobs(
  p_limit int default 10,
  p_worker text default 'worker',
  p_org_cap int default 2,
  p_lease_seconds int default 600
)
returns setof public.background_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 0));
begin
  update public.background_jobs
  set status = 'failed', finished_at = now(), locked_at = null, locked_by = null,
      lease_token = null, lease_expires_at = null,
      last_error = coalesce(last_error, 'lease expired after max attempts')
  where status = 'running' and lease_expires_at < now() and attempts >= max_attempts;

  return query
  with running as (
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

revoke execute on function public.claim_jobs(int, text, int, int) from public, anon, authenticated;
grant execute on function public.claim_jobs(int, text, int, int) to service_role;
