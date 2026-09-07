-- =============================================================================
-- Corridor — 0004 integrations, background jobs, billing
-- integration_configs (per-org provider settings; secrets live in Vault, only
-- a reference is stored), integration_events (every outbound/inbound call),
-- background_jobs (Postgres queue, FOR UPDATE SKIP LOCKED), subscriptions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- integration_configs
-- -----------------------------------------------------------------------------

create table public.integration_configs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider        text not null check (provider in ('cbp_ace','cbsa_aci','border_wait_time','hts_tariff','stripe')),
  environment     text not null default 'sandbox' check (environment in ('sandbox','production')),
  /** pointer into Supabase Vault (vault.secrets.id) — never a raw secret */
  credentials_ref uuid,
  /** non-secret settings, e.g. { "mockDelayMs": 5000, "mockFailureRate": 0 } */
  settings        jsonb not null default '{}'::jsonb,
  status          text not null default 'active' check (status in ('active','disabled','error')),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, provider)
);

create index integration_configs_org_idx on public.integration_configs (organization_id);
create trigger integration_configs_set_updated_at
  before update on public.integration_configs for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- integration_events — audit log of every call to/from a provider
-- -----------------------------------------------------------------------------

create table public.integration_events (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  movement_id      uuid references public.movements(id) on delete set null,
  provider         text not null,
  direction        text not null check (direction in ('outbound','inbound')),
  operation        text not null,                 -- e.g. transmit, decision, checkout
  request_payload  jsonb,
  response_payload jsonb,
  status_code      int,
  success          boolean not null,
  error_message    text,
  duration_ms      int,
  correlation_id   text,
  created_at       timestamptz not null default now()
);

create index integration_events_org_created_idx on public.integration_events (organization_id, created_at desc);
create index integration_events_movement_idx on public.integration_events (movement_id) where movement_id is not null;
create index integration_events_correlation_idx on public.integration_events (correlation_id) where correlation_id is not null;

-- -----------------------------------------------------------------------------
-- background_jobs — Postgres-table queue (Trigger.dev later if volume demands)
-- -----------------------------------------------------------------------------

create table public.background_jobs (
  id              bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  job_type        text not null,
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'pending' check (status in ('pending','running','succeeded','failed','cancelled')),
  run_at          timestamptz not null default now(),
  attempts        int not null default 0,
  max_attempts    int not null default 3,
  last_error      text,
  locked_at       timestamptz,
  locked_by       text,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz
);

create index background_jobs_due_idx on public.background_jobs (run_at) where status = 'pending';
create index background_jobs_org_idx on public.background_jobs (organization_id, created_at desc);

/**
 * Claim up to p_limit due jobs atomically. Workers call this under the
 * service role; concurrent workers never claim the same row.
 */
create or replace function public.claim_jobs(p_limit int default 10, p_worker text default 'worker')
returns setof public.background_jobs
language sql
security definer
set search_path = public
as $$
  with due as (
    select id from public.background_jobs
    where status = 'pending' and run_at <= now()
    order by run_at
    for update skip locked
    limit p_limit
  )
  update public.background_jobs j
  set status = 'running', attempts = j.attempts + 1, locked_at = now(), locked_by = p_worker, started_at = coalesce(j.started_at, now())
  from due
  where j.id = due.id
  returning j.*;
$$;

-- -----------------------------------------------------------------------------
-- subscriptions (Stripe mirror — card data never touches Corridor)
-- -----------------------------------------------------------------------------

create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  stripe_subscription_id text unique,
  plan                   text not null check (plan in ('trial','starter','professional','enterprise')),
  status                 text not null check (status in ('trialing','active','past_due','canceled','incomplete')),
  seats                  int not null default 1,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (organization_id)
);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions for each row execute function public.set_updated_at();

-- keep organizations.subscription_* in sync
create or replace function public.sync_org_subscription()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.organizations
  set subscription_plan = new.plan, subscription_status = new.status
  where id = new.organization_id;
  return new;
end;
$$;
create trigger subscriptions_sync_org
  after insert or update on public.subscriptions for each row execute function public.sync_org_subscription();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

alter table public.integration_configs enable row level security;
alter table public.integration_events  enable row level security;
alter table public.background_jobs     enable row level security;
alter table public.subscriptions       enable row level security;

create policy integration_configs_select on public.integration_configs for select to authenticated
  using (public.has_permission(organization_id, 'integrations.manage'));
create policy integration_configs_modify on public.integration_configs for all to authenticated
  using (public.has_permission(organization_id, 'integrations.manage'))
  with check (public.has_permission(organization_id, 'integrations.manage'));

-- events: readable with integrations.manage or movement.read (per-movement history)
create policy integration_events_select on public.integration_events for select to authenticated
  using (public.has_permission(organization_id, 'integrations.manage')
         or (movement_id is not null and public.has_permission(organization_id, 'movement.read')));
create policy integration_events_insert on public.integration_events for insert to authenticated
  with check (public.is_org_member(organization_id));

-- jobs: members may enqueue for their org; only service role processes (claim_jobs is definer)
-- members can see their org's jobs (needed for INSERT … RETURNING, which is
-- subject to the SELECT policy); job payloads carry ids only, never secrets.
create policy background_jobs_select on public.background_jobs for select to authenticated
  using (organization_id is not null and public.is_org_member(organization_id));
create policy background_jobs_insert on public.background_jobs for insert to authenticated
  with check (organization_id is not null and public.is_org_member(organization_id));

create policy subscriptions_select on public.subscriptions for select to authenticated
  using (public.has_permission(organization_id, 'billing.read'));
-- writes come from the Stripe webhook / billing service (service role) only

grant select, insert, update, delete on public.integration_configs, public.integration_events,
  public.background_jobs, public.subscriptions to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
revoke update, delete on public.integration_events from authenticated;
revoke update, delete on public.background_jobs from authenticated;
revoke insert, update, delete on public.subscriptions from authenticated;
revoke execute on function public.claim_jobs(int, text) from public, authenticated;
grant execute on function public.claim_jobs(int, text) to service_role;
