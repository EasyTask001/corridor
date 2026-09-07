-- =============================================================================
-- Corridor — 0006 notifications
-- notifications (per-user inbox) + notification_rules (per-user, per-event-type
-- opt-out / channel preference). Fan-out to org members happens through
-- notify_organization(), a SECURITY DEFINER function so it works identically
-- whether called from a user's RLS transaction or a service-role background
-- job — callers never construct arbitrary user_id rows themselves.
-- =============================================================================

create table public.notifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  event_type      text not null,
  title           text not null,
  body            text,
  link_path       text,
  channel         text[] not null default array['in_app'],
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index notifications_user_created_idx on public.notifications (user_id, created_at desc);
create index notifications_user_unread_idx on public.notifications (user_id) where read_at is null;

create table public.notification_rules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  event_type      text not null,
  enabled         boolean not null default true,
  channel         text[] not null default array['in_app'],
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, user_id, event_type)
);

create trigger notification_rules_set_updated_at
  before update on public.notification_rules for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS: everyone sees/manages only their own rows.
-- -----------------------------------------------------------------------------

alter table public.notifications enable row level security;
alter table public.notification_rules enable row level security;

create policy notifications_select on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
-- no authenticated insert/delete policy: rows are created via notify_organization()

create policy notification_rules_select on public.notification_rules for select to authenticated
  using (user_id = (select auth.uid()) and public.is_org_member(organization_id));
create policy notification_rules_upsert on public.notification_rules for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_org_member(organization_id));
create policy notification_rules_update on public.notification_rules for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy notification_rules_delete on public.notification_rules for delete to authenticated
  using (user_id = (select auth.uid()));

grant select, update on public.notifications to authenticated;
grant select, insert, update, delete on public.notification_rules to authenticated;
grant select, insert, update, delete on public.notifications, public.notification_rules to service_role;

-- -----------------------------------------------------------------------------
-- notify_organization: fan out one notification to every active member who
-- (a) holds p_required_permission, and (b) hasn't disabled this event_type.
-- Returns the created rows joined to the recipient's email, so the caller can
-- decide which ones to also send by email (channel contains 'email').
-- -----------------------------------------------------------------------------

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
    insert into public.notifications (organization_id, user_id, event_type, title, body, link_path, channel)
    select p_organization_id, recipients.user_id, p_event_type, p_title, p_body, p_link_path, recipients.channel
    from recipients
    returning id, notifications.user_id as uid
  )
  select inserted.id, inserted.uid, recipients.email, recipients.channel
  from inserted
  join recipients on recipients.user_id = inserted.uid;
$$;

grant execute on function public.notify_organization(uuid, text, text, text, text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Realtime: the bell updates live.
-- -----------------------------------------------------------------------------

alter publication supabase_realtime add table public.notifications;
