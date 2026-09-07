-- =============================================================================
-- Corridor — 0017 notify_organization caller guard
--
-- notify_organization() is SECURITY DEFINER and EXECUTE-granted to
-- `authenticated` (0006, re-created in 0011). It takes p_organization_id from
-- the caller, returns every matching member's email address, and inserts rows
-- into a table `authenticated` has no INSERT policy on. Until now it checked
-- nothing: any signed-in user could call it through PostgREST with another
-- tenant's organization id and (a) enumerate that tenant's member emails and
-- (b) plant arbitrary notifications in their inboxes.
--
-- The fix is the guard `record_usage` already uses (0013): re-check membership,
-- but only when there is a JWT at all. The background worker calls this under
-- the service role in a transaction with no request.jwt.claims and hence no
-- auth.uid(); every browser-reachable caller always carries claims (withRls
-- sets them before handing the transaction to application code), so that path
-- is always checked.
--
-- Converted from `language sql` to plpgsql for the guard. Same signature, same
-- result columns, same body otherwise — 0011's version verbatim.
-- =============================================================================

create or replace function public.notify_organization(
  p_organization_id uuid,
  p_event_type text,
  p_required_permission text,
  p_title text,
  p_body text default null,
  p_link_path text default null
)
returns table (notification_id uuid, user_id uuid, email text, channel text[])
language plpgsql
security definer
set search_path = public
as $$
-- RETURNS TABLE turns user_id/email/channel into plpgsql OUT variables; the
-- body's identically named column references must still mean the columns.
#variable_conflict use_column
begin
  if (select auth.uid()) is not null and not public.is_org_member(p_organization_id) then
    raise exception 'not a member of organization %', p_organization_id using errcode = '42501';
  end if;

  return query
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
end;
$$;

-- Supabase's default privileges hand EXECUTE on public functions to anon +
-- authenticated; `anon` has never had a use for this one.
revoke execute on function public.notify_organization(uuid, text, text, text, text, text)
  from public, anon;
grant execute on function public.notify_organization(uuid, text, text, text, text, text)
  to authenticated, service_role;
