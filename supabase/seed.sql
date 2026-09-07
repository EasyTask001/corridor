-- =============================================================================
-- GENERATED FILE — do not edit by hand.
-- Source: packages/domain/src/permission.ts + role.ts
-- Regenerate: pnpm --filter @corridor/db seed:generate
-- Idempotent: safe to re-run against an existing database.
-- =============================================================================

-- permissions catalogue
insert into public.permissions (key, description, module) values
  ('organization.read', 'View organization profile', 'organization'),
  ('organization.manage', 'Edit organization profile', 'organization'),
  ('organization.members.read', 'View members', 'organization'),
  ('organization.members.manage', 'Invite, suspend, or remove members', 'organization'),
  ('organization.roles.manage', 'Create/edit custom roles', 'organization'),
  ('billing.read', 'View subscription and invoices', 'billing'),
  ('billing.manage', 'Change plan / payment method', 'billing'),
  ('integrations.manage', 'Configure customs/tariff APIs', 'integrations'),
  ('audit_log.read', 'View audit log', 'organization'),
  ('driver.read', 'View drivers', 'registry'),
  ('driver.write', 'Create/edit drivers', 'registry'),
  ('truck.read', 'View trucks', 'registry'),
  ('truck.write', 'Create/edit trucks', 'registry'),
  ('trailer.read', 'View trailers', 'registry'),
  ('trailer.write', 'Create/edit trailers', 'registry'),
  ('partner.read', 'View shippers/consignees/brokers', 'registry'),
  ('partner.write', 'Create/edit shippers/consignees/brokers', 'registry'),
  ('movement.read', 'View movements', 'movement'),
  ('movement.write', 'Create/edit draft movements', 'movement'),
  ('movement.transmit_to_customs', 'Transmit manifests to CBP/CBSA', 'movement'),
  ('movement.amend', 'Submit amendments', 'movement'),
  ('movement.cancel', 'Cancel movements', 'movement'),
  ('movement.read_assigned', 'View movements assigned to me (driver portal)', 'movement'),
  ('shipment.read', 'View shipments and commodities', 'shipment'),
  ('shipment.write', 'Create/edit shipments, commodities and their movement assignment', 'shipment'),
  ('document.read', 'View uploaded documents', 'document'),
  ('document.upload', 'Upload documents', 'document'),
  ('document.review_extraction', 'Confirm or correct AI-extracted data', 'document'),
  ('alert.read', 'View compliance alerts', 'compliance'),
  ('alert.manage', 'Acknowledge/resolve/dismiss alerts', 'compliance'),
  ('report.read', 'Run reports', 'reporting'),
  ('copilot.use', 'Use the compliance copilot', 'copilot')
on conflict (key) do update set description = excluded.description, module = excluded.module;

-- system role templates (organization_id = null)
insert into public.roles (name, is_system, organization_id) values
  ('Owner', true, null),
  ('Admin', true, null),
  ('Dispatcher', true, null),
  ('Compliance Officer', true, null),
  ('Read-Only', true, null),
  ('Driver-Portal', true, null)
on conflict do nothing;

-- system role grants (replace-all per role so removals propagate)
delete from public.role_permissions rp using public.roles r
  where rp.role_id = r.id and r.is_system and r.name = 'Owner';
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
  where r.is_system and r.name = 'Owner'
    and p.key in ('organization.read', 'organization.manage', 'organization.members.read', 'organization.members.manage', 'organization.roles.manage', 'billing.read', 'billing.manage', 'integrations.manage', 'audit_log.read', 'driver.read', 'driver.write', 'truck.read', 'truck.write', 'trailer.read', 'trailer.write', 'partner.read', 'partner.write', 'movement.read', 'movement.write', 'movement.transmit_to_customs', 'movement.amend', 'movement.cancel', 'movement.read_assigned', 'shipment.read', 'shipment.write', 'document.read', 'document.upload', 'document.review_extraction', 'alert.read', 'alert.manage', 'report.read', 'copilot.use');

delete from public.role_permissions rp using public.roles r
  where rp.role_id = r.id and r.is_system and r.name = 'Admin';
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
  where r.is_system and r.name = 'Admin'
    and p.key in ('organization.read', 'organization.manage', 'organization.members.read', 'organization.members.manage', 'organization.roles.manage', 'billing.read', 'integrations.manage', 'audit_log.read', 'driver.read', 'driver.write', 'truck.read', 'truck.write', 'trailer.read', 'trailer.write', 'partner.read', 'partner.write', 'movement.read', 'movement.write', 'movement.transmit_to_customs', 'movement.amend', 'movement.cancel', 'movement.read_assigned', 'shipment.read', 'shipment.write', 'document.read', 'document.upload', 'document.review_extraction', 'alert.read', 'alert.manage', 'report.read', 'copilot.use');

delete from public.role_permissions rp using public.roles r
  where rp.role_id = r.id and r.is_system and r.name = 'Dispatcher';
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
  where r.is_system and r.name = 'Dispatcher'
    and p.key in ('organization.read', 'driver.read', 'driver.write', 'truck.read', 'truck.write', 'trailer.read', 'trailer.write', 'partner.read', 'partner.write', 'movement.read', 'movement.write', 'movement.transmit_to_customs', 'movement.amend', 'movement.cancel', 'shipment.read', 'shipment.write', 'document.read', 'document.upload', 'document.review_extraction', 'alert.read', 'alert.manage', 'report.read', 'copilot.use');

delete from public.role_permissions rp using public.roles r
  where rp.role_id = r.id and r.is_system and r.name = 'Compliance Officer';
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
  where r.is_system and r.name = 'Compliance Officer'
    and p.key in ('organization.read', 'organization.members.read', 'billing.read', 'audit_log.read', 'driver.read', 'truck.read', 'trailer.read', 'partner.read', 'movement.read', 'shipment.read', 'document.read', 'alert.read', 'report.read', 'alert.manage', 'document.review_extraction', 'copilot.use', 'movement.amend');

delete from public.role_permissions rp using public.roles r
  where rp.role_id = r.id and r.is_system and r.name = 'Read-Only';
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
  where r.is_system and r.name = 'Read-Only'
    and p.key in ('organization.read', 'organization.members.read', 'billing.read', 'audit_log.read', 'driver.read', 'truck.read', 'trailer.read', 'partner.read', 'movement.read', 'shipment.read', 'document.read', 'alert.read', 'report.read');

delete from public.role_permissions rp using public.roles r
  where rp.role_id = r.id and r.is_system and r.name = 'Driver-Portal';
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
  where r.is_system and r.name = 'Driver-Portal'
    and p.key in ('movement.read_assigned', 'document.upload');

