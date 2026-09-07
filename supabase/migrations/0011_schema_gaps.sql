-- =============================================================================
-- Corridor — 0011 schema gaps
-- Closes the database-layer gaps an audit found after Phase 8:
--   * notification_rules.filters (per-rule narrowing, e.g. only ACE movements)
--   * notifications.event_type renamed to notifications.type (plan name)
--   * missing tenant-scoping indexes on hot list queries
--   * missing DELETE/UPDATE policies (rows were reachable but unremovable)
--   * dead helper function dropped
--   * per-organization concurrency cap in claim_jobs() so one tenant's AI
--     backlog cannot starve every other tenant's queue
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. notification_rules.filters — optional per-rule narrowing predicate.
--    notification_rules.event_type stays: it is the rule *selector*, not the
--    notification's own type.
-- -----------------------------------------------------------------------------

alter table public.notification_rules
  add column filters jsonb not null default '{}'::jsonb;

-- -----------------------------------------------------------------------------
-- 2. notifications.event_type -> notifications.type
-- -----------------------------------------------------------------------------

alter table public.notifications rename column event_type to type;

-- notify_organization() writes the renamed column. The p_event_type argument
-- keeps its name (renaming an argument is not possible with CREATE OR REPLACE,
-- and it doubles as the notification_rules.event_type selector).
create or replace function public.notify_organization(
  p_organization_id uuid,
  p_event_type text,
  p_required_permission text,
  p_title text,
  p_body text default null,
  p_link_path text default null
)
returns table (notification_id uuid, user_id uuid, email text, channel text[])
language sql
security definer
set search_path = public
as $$
  with recipients as (
    select distinct
      m.user_id,
      u.email::text as email,
      coalesce(r.channel, array['in_app']) as channel
    from public.organization_members m
    join public.role_permissions rp on rp.role_id = m.role_id
    join public.permissions p on p.id = rp.permission_id and p.key = p_required_permission
    join auth.users u on u.id = m.user_id
    left join public.notification_rules r
      on r.organization_id = p_organization_id and r.user_id = m.user_id and r.event_type = p_event_type
    where m.organization_id = p_organization_id
      and m.status = 'active'
      and coalesce(r.enabled, true)
  ),
  inserted as (
    insert into public.notifications (organization_id, user_id, type, title, body, link_path, channel)
    select p_organization_id, recipients.user_id, p_event_type, p_title, p_body, p_link_path, recipients.channel
    from recipients
    returning id, notifications.user_id as uid
  )
  select inserted.id, inserted.uid, recipients.email, recipients.channel
  from inserted
  join recipients on recipients.user_id = inserted.uid;
$$;

-- -----------------------------------------------------------------------------
-- 3. Missing indexes. Every one of these backs a query the app already runs
--    (tenant-scoped list / cascade delete) but which had no supporting index.
-- -----------------------------------------------------------------------------

create index seals_organization_id_idx on public.seals (organization_id);
create index movement_amendments_organization_id_idx
  on public.movement_amendments (organization_id);
create index notifications_org_created_idx
  on public.notifications (organization_id, created_at desc);
create index compliance_alerts_org_created_idx
  on public.compliance_alerts (organization_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 4. Missing write policies.
--    Drafts are the only deletable movements/amendments — anything transmitted
--    to customs must stay on the record and be cancelled, never removed.
-- -----------------------------------------------------------------------------

create policy movements_delete on public.movements for delete to authenticated
  using (public.has_permission(organization_id, 'movement.write') and status = 'draft');

-- Deleting a movement cascades into cargo/seals, and the child guard fired on
-- those cascaded rows after the parent was already gone — so it raised
-- "movement not found" and made the DELETE policy above unusable for any
-- movement that actually had lines. A child DELETE whose parent no longer
-- exists is by definition part of that cascade; let it through. Every other
-- path (insert/update, or a direct child delete while the parent lives) still
-- goes through the editable-status check unchanged.
create or replace function public.movement_children_guard()
returns trigger
language plpgsql
as $$
declare
  v_movement_id uuid := coalesce(new.movement_id, old.movement_id);
  v_status text;
begin
  select status into v_status from public.movements where id = v_movement_id;
  if v_status is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    raise exception 'movement % not found', v_movement_id using errcode = 'P0002';
  end if;
  if not public.movement_is_editable(v_status) then
    raise exception 'movement is not editable in status %', v_status using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

-- Same story for the timeline: every movement is created with a status_change
-- event, so the blanket append-only trigger rejected the cascade and no draft
-- was ever deletable. A movement_events DELETE is only reachable through that
-- cascade (authenticated has no DELETE privilege on the table and there is no
-- DELETE policy), so allowing it exactly when the parent movement is gone
-- keeps the timeline append-only for every path a caller can actually take.
create or replace function public.movement_events_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and not exists (select 1 from public.movements m where m.id = old.movement_id) then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = 'P0001';
end;
$$;

drop trigger movement_events_append_only on public.movement_events;
create trigger movement_events_append_only
  before update or delete on public.movement_events
  for each row execute function public.movement_events_immutable();

create policy movement_amendments_delete on public.movement_amendments for delete to authenticated
  using (public.has_permission(organization_id, 'movement.write') and status = 'draft');

create policy org_knowledge_update on public.organization_knowledge_embeddings
  for update to authenticated
  using (public.has_permission(organization_id, 'copilot.use'))
  with check (public.has_permission(organization_id, 'copilot.use'));

create policy org_knowledge_delete on public.organization_knowledge_embeddings
  for delete to authenticated
  using (public.has_permission(organization_id, 'copilot.use'));

grant delete on public.movements, public.movement_amendments to authenticated;
grant update, delete on public.organization_knowledge_embeddings to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Dead code: superseded by is_org_member()/has_permission() in every policy.
-- -----------------------------------------------------------------------------

drop function if exists public.current_user_org_ids();

-- -----------------------------------------------------------------------------
-- 6. Per-organization concurrency cap for the job queue.
--    A tenant that enqueues hundreds of AI extractions must not monopolise the
--    worker: a pending job is skipped while its organization already has
--    p_org_cap rows in status 'running'. Jobs with a null organization_id are
--    internal/system work and are never capped.
--    The old two-argument function is dropped rather than replaced so the
--    3-argument version is the only overload (existing 2-argument callers keep
--    working through the default).
-- -----------------------------------------------------------------------------

drop function if exists public.claim_jobs(int, text);

create or replace function public.claim_jobs(
  p_limit int default 10,
  p_worker text default 'worker',
  p_org_cap int default 2
)
returns setof public.background_jobs
language sql
security definer
set search_path = public
as $$
  with running as (
    select organization_id, count(*)::int as running_count
    from public.background_jobs
    where status = 'running' and organization_id is not null
    group by organization_id
  ),
  ranked as (
    select
      j.id,
      j.organization_id,
      row_number() over (partition by j.organization_id order by j.run_at, j.id) as rn
    from public.background_jobs j
    where j.status = 'pending' and j.run_at <= now()
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
  set status = 'running', attempts = j.attempts + 1, locked_at = now(), locked_by = p_worker, started_at = coalesce(j.started_at, now())
  from due
  where j.id = due.id
  returning j.*;
$$;

revoke execute on function public.claim_jobs(int, text, int) from public, authenticated;
grant execute on function public.claim_jobs(int, text, int) to service_role;
