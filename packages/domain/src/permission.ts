import { z } from "zod";

/**
 * Permission keys are the single source of truth for feature/action gating.
 * They are seeded into the `permissions` table (see supabase/seed.sql) and
 * checked by tRPC's `enforcePermission()` middleware. RLS remains the hard
 * tenant boundary; permissions are the feature boundary on top of it.
 */
export const PERMISSIONS = {
  // organization
  "organization.read": { module: "organization", description: "View organization profile" },
  "organization.manage": { module: "organization", description: "Edit organization profile" },
  "organization.members.read": { module: "organization", description: "View members" },
  "organization.members.manage": {
    module: "organization",
    description: "Invite, suspend, or remove members",
  },
  "organization.roles.manage": { module: "organization", description: "Create/edit custom roles" },
  "billing.read": { module: "billing", description: "View subscription and invoices" },
  "billing.manage": { module: "billing", description: "Change plan / payment method" },
  "integrations.manage": { module: "integrations", description: "Configure customs/tariff APIs" },
  "audit_log.read": { module: "organization", description: "View audit log" },

  // registries
  "driver.read": { module: "registry", description: "View drivers" },
  "driver.write": { module: "registry", description: "Create/edit drivers" },
  "truck.read": { module: "registry", description: "View trucks" },
  "truck.write": { module: "registry", description: "Create/edit trucks" },
  "trailer.read": { module: "registry", description: "View trailers" },
  "trailer.write": { module: "registry", description: "Create/edit trailers" },
  "partner.read": { module: "registry", description: "View shippers/consignees/brokers" },
  "partner.write": { module: "registry", description: "Create/edit shippers/consignees/brokers" },

  // movements
  "movement.read": { module: "movement", description: "View movements" },
  "movement.write": { module: "movement", description: "Create/edit draft movements" },
  "movement.transmit_to_customs": {
    module: "movement",
    description: "Transmit manifests to CBP/CBSA",
  },
  "movement.amend": { module: "movement", description: "Submit amendments" },
  "movement.cancel": { module: "movement", description: "Cancel movements" },
  "movement.read_assigned": {
    module: "movement",
    description: "View movements assigned to me (driver portal)",
  },

  // shipments
  "shipment.read": { module: "shipment", description: "View shipments and commodities" },
  "shipment.write": {
    module: "shipment",
    description: "Create/edit shipments, commodities and their movement assignment",
  },

  // documents
  "document.read": { module: "document", description: "View uploaded documents" },
  "document.upload": { module: "document", description: "Upload documents" },
  "document.review_extraction": {
    module: "document",
    description: "Confirm or correct AI-extracted data",
  },

  // compliance
  "alert.read": { module: "compliance", description: "View compliance alerts" },
  "alert.manage": { module: "compliance", description: "Acknowledge/resolve/dismiss alerts" },

  // reporting & copilot
  "report.read": { module: "reporting", description: "Run reports" },
  "copilot.use": { module: "copilot", description: "Use the compliance copilot" },
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as [PermissionKey, ...PermissionKey[]];
export const permissionKey = z.enum(PERMISSION_KEYS);

export const permissionSchema = z.object({
  id: z.string().uuid(),
  key: permissionKey,
  description: z.string(),
  module: z.string(),
});
export type Permission = z.infer<typeof permissionSchema>;
