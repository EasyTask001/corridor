-- =============================================================================
-- Corridor — 0030 FK index hardening
--
-- A db-lint pass against the supabase-postgres-best-practices skill found two
-- foreign-key columns with zero index coverage (checked against the live
-- schema, not just a naive "leading column of some index" grep):
--
-- - organization_members.role_id (ON DELETE RESTRICT): joined directly in
--   notify_organization() and in the member-list query
--   (packages/api/src/router/organization.ts), and a restrict-delete of a role
--   still has to scan for referencing members. Neither organization_members
--   index today (user_id, organization_id) covers it.
-- - role_permissions.permission_id (ON DELETE CASCADE): the table's only index
--   is its PK, (role_id, permission_id) — permission_id is never the leading
--   column, so deleting a permission has to seq-scan role_permissions to find
--   the rows to cascade. Low frequency (permissions is close to static seed
--   data) but still the FK the cascade actually walks.
--
-- Two other candidates from the same raw "unindexed FK" query — drivers.user_id
-- and notification_rules.user_id — turned out to be false positives on closer
-- read: every real query against them filters (organization_id, user_id, ...)
-- together, which the existing composite/partial unique indexes already cover.
-- Not repeated here.
-- =============================================================================

create index organization_members_role_id_idx on public.organization_members (role_id);
create index role_permissions_permission_id_idx on public.role_permissions (permission_id);
