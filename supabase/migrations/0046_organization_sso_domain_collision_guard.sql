-- Corridor — 0046 reject a cross-organization SSO domain collision (ISSUE-008 followup)
--
-- organization_sso.domains has a CHECK on shape (sso_domains_valid: 1-20
-- lowercase, well-formed domains) but nothing stopped two different
-- organizations from listing the same domain. The only thing that made this
-- safe was Supabase Auth (GoTrue) rejecting a duplicate domain when its SSO
-- provider is registered — an external guarantee, not one Corridor's own
-- schema enforced. sso_provider_for_email / sso_enforced_for_email
-- (0014) — both anon-reachable, on the unauthenticated login path — resolve
-- a domain to an organization with `order by created_at, organization_id
-- limit 1`, so if that external guarantee were ever bypassed (a domain
-- removed from GoTrue out of band while the old organization's row still
-- lists it, then claimed by a second organization), a login could silently
-- resolve to the wrong tenant's provider.
--
-- This guard makes the invariant independent of GoTrue: no two rows in
-- organization_sso may ever share a domain, checked directly against the
-- table itself. It does not name the other organization in its error — the
-- caller already knows the domain they submitted, and there is no reason to
-- confirm which tenant owns it.

create or replace function public.organization_sso_domain_collision_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- RLS on organization_sso limits `authenticated` to its own row
  -- (has_permission(organization_id, 'organization.manage')), so this check
  -- needs definer privileges to see every other organization's domains.
  if exists (
    select 1
    from public.organization_sso s
    where s.organization_id <> new.organization_id
      and s.domains && new.domains
  ) then
    raise exception 'one or more of these domains is already configured for another organization';
  end if;
  return new;
end;
$$;

create trigger organization_sso_domain_collision_guard
  before insert or update of domains on public.organization_sso
  for each row execute function public.organization_sso_domain_collision_guard();

revoke execute on function public.organization_sso_domain_collision_guard() from public;
