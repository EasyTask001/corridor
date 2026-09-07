-- =============================================================================
-- Corridor — 0015 user_devices (Expo driver app push registration)
--
-- One row per (user, Expo push token). A driver may sign in on more than one
-- handset, so the fan-out sends to every device the recipient registered.
-- `organization_id` records the org that was active when the device was
-- registered; the push fan-out is org-scoped so a token registered against
-- another org is never used for this org's notifications.
-- =============================================================================

create table public.user_devices (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  expo_push_token  text not null,
  platform         text not null check (platform in ('ios', 'android')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, expo_push_token)
);

create index user_devices_user_created_idx on public.user_devices (user_id, created_at desc);
create index user_devices_org_idx on public.user_devices (organization_id);

create trigger user_devices_set_updated_at
  before update on public.user_devices for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS: a device belongs to exactly one person. Everyone reads and writes only
-- their own rows — there is deliberately no org-wide read policy, so one member
-- can never enumerate another member's handsets. The fan-out reaches other
-- users' tokens only through push_tokens_for() below.
-- -----------------------------------------------------------------------------

alter table public.user_devices enable row level security;

create policy user_devices_select on public.user_devices for select to authenticated
  using (user_id = (select auth.uid()));
create policy user_devices_insert on public.user_devices for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_org_member(organization_id));
create policy user_devices_update on public.user_devices for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.is_org_member(organization_id));
create policy user_devices_delete on public.user_devices for delete to authenticated
  using (user_id = (select auth.uid()));

grant select, insert, update, delete on public.user_devices to authenticated;
grant select, insert, update, delete on public.user_devices to service_role;

-- -----------------------------------------------------------------------------
-- push_tokens_for: the push counterpart of notify_organization()'s `email`
-- column. SECURITY DEFINER so the notification fan-out can reach a recipient's
-- tokens even though `user_devices` is user-scoped.
--
-- A push token is a bearer capability: whoever holds it can send that handset a
-- notification. It is therefore NOT exposed to `authenticated` — the default
-- PUBLIC grant is revoked and only `service_role` may execute it, so the
-- function cannot be called from PostgREST with an arbitrary p_organization_id.
-- The fan-out (`packages/api/src/services/notifications.ts`) accordingly runs
-- its push step in a service-role transaction rather than the caller's.
--
-- Only tokens of *active members of the given organization* are returned, and
-- only for the user ids passed in.
-- -----------------------------------------------------------------------------

create or replace function public.push_tokens_for(
  p_organization_id uuid,
  p_user_ids uuid[]
)
returns table (user_id uuid, expo_push_token text, platform text)
language sql
stable
security definer
set search_path = public
as $$
  select d.user_id, d.expo_push_token, d.platform
  from public.user_devices d
  join public.organization_members m
    on m.user_id = d.user_id
   and m.organization_id = p_organization_id
   and m.status = 'active'
  where d.organization_id = p_organization_id
    and d.user_id = any(p_user_ids);
$$;

revoke all on function public.push_tokens_for(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.push_tokens_for(uuid, uuid[]) to service_role;
