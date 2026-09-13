-- Corridor — 0050 production hardening guards
--
-- Queue-wide jobs use organization_id = NULL. PostgreSQL's NULL semantics
-- make the tenant-scoped idempotency index unable to deduplicate those rows.
-- This partial index makes the every-minute BorderConnect drain and other
-- queue-wide jobs conflict-safe under concurrent cron/manual producers.

create unique index background_jobs_queue_idempotency_unique
  on public.background_jobs (job_type, idempotency_key)
  where organization_id is null and idempotency_key is not null;

-- BorderConnect's contract manual limits company keys to 30 characters. Keep
-- the tenant setting and database guard aligned with the wire contract.
alter table public.organizations
  drop constraint if exists organizations_border_connect_company_key_check;
alter table public.organizations
  add constraint organizations_border_connect_company_key_check
  check (border_connect_company_key is null or char_length(border_connect_company_key) between 1 and 30);

-- Lock the selected partner while checking its role. This serializes a
-- shipment assignment with a concurrent partner demotion, so both cannot
-- commit an assigned non-broker state.
create or replace function public.validate_shipment_broker_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.broker_id is not null and not exists (
    select 1 from public.partners p
    where p.id = new.broker_id
      and p.organization_id = new.organization_id
      and p.type in ('broker', 'both')
    for update
  ) then
    raise check_violation using
      constraint = 'shipments_broker_role_guard',
      message = 'shipment broker must be a broker or dual-role partner in the same organization';
  end if;
  return new;
end;
$$;
