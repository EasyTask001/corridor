-- Corridor — Phase 9 custom-role hardening

-- Names are case-insensitively unique inside a tenant. System role names stay
-- global templates and are intentionally excluded from this index.
create unique index if not exists roles_organization_name_unique
  on public.roles (organization_id, lower(name))
  where organization_id is not null;
