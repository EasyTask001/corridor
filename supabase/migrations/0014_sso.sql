-- =============================================================================
-- Corridor — 0014 SAML single sign-on (enterprise)
--
-- Supabase Auth owns SAML: the providers, the domain→provider mapping used for
-- the redirect, and the assertion handling all live in GoTrue and are managed
-- through its admin API (packages/integrations/src/sso.ts). This migration adds
-- the *Corridor* side of that:
--
--   1. organization_sso — which organization owns which GoTrue provider, the
--      domains it claims, and whether password sign-in is switched off for
--      them. One row per organization; RLS gates it on `organization.manage`,
--      the same permission that edits the rest of the organization profile.
--   2. sso_provider_for_email() / sso_enforced_for_email() — SECURITY DEFINER
--      resolvers granted to `anon`, because the login page has to answer "does
--      this address sign in with SSO?" *before* anyone is authenticated.
--
-- The resolvers are the only part of this table reachable without a session,
-- and `GET /api/auth/sso` reduces even their answers to two booleans: an
-- unauthenticated caller never learns a provider id, an organization id or a
-- name from an email address.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. organization_sso
--
-- `provider_id` is GoTrue's SSO provider uuid, stored as text because the mock
-- mode used when no SAML-capable Auth instance is configured issues synthetic
-- ids prefixed `mock-sso-` (see packages/integrations/src/sso.ts).
--
-- `domains` mirrors the domain list registered with the provider in GoTrue.
-- GoTrue itself enforces that a domain is claimed by at most one provider —
-- registering a duplicate fails there — so this column does not re-implement
-- that constraint; it is the login-page hint and the enforcement list. The
-- CHECK keeps the values in the shape the resolvers compare against: 1–20
-- entries, each a non-empty lower-case DNS domain with at least one dot (so a
-- bare label can never claim every address that ends in it).
--
-- The check delegates to a function because a CHECK constraint may not contain
-- a subquery, and validating each element of an array needs one.
-- -----------------------------------------------------------------------------

create or replace function public.sso_domains_valid(p_domains text[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(array_length(p_domains, 1), 0) between 1 and 20
     and not exists (
       select 1
       from unnest(p_domains) as d
       where d is null
          or d <> lower(d)
          or d !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
     )
$$;

create table public.organization_sso (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  provider_id     text not null,
  domains         text[] not null,
  enforced        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint organization_sso_provider_id_not_blank check (length(btrim(provider_id)) > 0),
  constraint organization_sso_domains_shape check (public.sso_domains_valid(domains))
);

create trigger organization_sso_set_updated_at
  before update on public.organization_sso
  for each row execute function public.set_updated_at();

-- Backs the resolvers' `<domain> = any(domains)` containment lookup.
create index organization_sso_domains_idx
  on public.organization_sso using gin (domains);

-- -----------------------------------------------------------------------------
-- 2. Public resolvers.
--
-- Both are SECURITY DEFINER and granted to `anon`: the login page must route an
-- SSO user who has no session yet. They take a whole address rather than a
-- domain so a caller cannot enumerate the table by walking a domain list any
-- faster than it could by walking an address list, and they return one scalar
-- each — never the row, the organization, or anything joined to it.
--
-- STABLE, not IMMUTABLE: the answer changes when the table does.
--
-- Two functions rather than one composite because the brief's public primitive
-- is `sso_provider_for_email(citext) returns text`; the enforcement flag is a
-- separate question the same way, and both are one index lookup.
-- -----------------------------------------------------------------------------

create or replace function public.sso_email_domain(p_email citext)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(lower(split_part(p_email::text, '@', 2)), '')
$$;

create or replace function public.sso_provider_for_email(p_email citext)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.provider_id
  from public.organization_sso s
  where public.sso_email_domain(p_email) = any (s.domains)
  -- Deterministic when GoTrue's own uniqueness has somehow been bypassed
  -- (a domain removed there but not here): oldest configuration wins.
  order by s.created_at, s.organization_id
  limit 1
$$;

create or replace function public.sso_enforced_for_email(p_email citext)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select s.enforced
      from public.organization_sso s
      where public.sso_email_domain(p_email) = any (s.domains)
      order by s.created_at, s.organization_id
      limit 1
    ),
    false
  )
$$;

-- -----------------------------------------------------------------------------
-- 3. RLS + grants.
--
-- Reads and writes both require `organization.manage`: the SSO configuration is
-- part of the organization profile, and the provider id is an identifier for
-- the tenant's IdP that ordinary members have no reason to see. Nothing here is
-- readable by `anon` — only the two resolvers above are, and they return
-- scalars.
-- -----------------------------------------------------------------------------

alter table public.organization_sso enable row level security;

create policy organization_sso_select on public.organization_sso
  for select to authenticated
  using (public.has_permission(organization_id, 'organization.manage'));

create policy organization_sso_insert on public.organization_sso
  for insert to authenticated
  with check (public.has_permission(organization_id, 'organization.manage'));

create policy organization_sso_update on public.organization_sso
  for update to authenticated
  using (public.has_permission(organization_id, 'organization.manage'))
  with check (public.has_permission(organization_id, 'organization.manage'));

create policy organization_sso_delete on public.organization_sso
  for delete to authenticated
  using (public.has_permission(organization_id, 'organization.manage'));

grant select, insert, update, delete on public.organization_sso to authenticated, service_role;
-- Belt and braces: a fresh Supabase project exposes new public tables to the
-- Data API roles automatically ([api] auto_expose_new_tables), which would give
-- `anon` a SELECT privilege that RLS then reduces to zero rows. This table is
-- reachable without a session only through the two resolvers below, so take the
-- privilege away rather than relying on the policies alone.
revoke all on public.organization_sso from anon;

revoke execute on function public.sso_provider_for_email(citext) from public;
revoke execute on function public.sso_enforced_for_email(citext) from public;
grant execute on function public.sso_email_domain(citext) to anon, authenticated, service_role;
grant execute on function public.sso_provider_for_email(citext) to anon, authenticated, service_role;
grant execute on function public.sso_enforced_for_email(citext) to anon, authenticated, service_role;
