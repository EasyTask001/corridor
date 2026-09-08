import { z } from "zod";
import { uuid } from "./common";
import { PERMISSION_KEYS, permissionKey, type PermissionKey } from "./permission";

/**
 * System role templates. Seeded with `organization_id = NULL` in the `roles`
 * table; every organization can use them. Custom roles (enterprise plan) are
 * per-organization rows with `is_system = false`.
 */
export const SYSTEM_ROLES = {
  owner: "Owner",
  admin: "Admin",
  dispatcher: "Dispatcher",
  compliance_officer: "Compliance Officer",
  read_only: "Read-Only",
  driver_portal: "Driver-Portal",
} as const;

export type SystemRoleKey = keyof typeof SYSTEM_ROLES;
export const systemRoleKey = z.enum(
  Object.keys(SYSTEM_ROLES) as [SystemRoleKey, ...SystemRoleKey[]],
);

const readKeys = PERMISSION_KEYS.filter((k) => k.endsWith(".read"));

/** Permission grants for each system role — the seed script derives `role_permissions` from this. */
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleKey, readonly PermissionKey[]> = {
  owner: PERMISSION_KEYS,
  admin: PERMISSION_KEYS.filter((k) => k !== "billing.manage"),
  dispatcher: [
    "organization.read",
    "driver.read",
    "driver.write",
    "truck.read",
    "truck.write",
    "trailer.read",
    "trailer.write",
    "partner.read",
    "partner.write",
    "movement.read",
    "movement.write",
    "movement.transmit_to_customs",
    "movement.amend",
    "movement.cancel",
    "shipment.read",
    "shipment.write",
    "inbond.read",
    "inbond.write",
    "document.read",
    "document.upload",
    "document.review_extraction",
    "alert.read",
    "alert.manage",
    "report.read",
    "copilot.use",
  ],
  compliance_officer: [
    ...readKeys,
    "alert.manage",
    "document.review_extraction",
    "copilot.use",
    "movement.amend",
  ],
  read_only: readKeys,
  driver_portal: ["movement.read_assigned", "document.upload"],
};

export const membershipStatus = z.enum(["invited", "active", "suspended"]);
export type MembershipStatus = z.infer<typeof membershipStatus>;

export const roleSchema = z.object({
  id: uuid,
  organizationId: uuid.nullable(),
  name: z.string().min(1).max(64),
  isSystem: z.boolean(),
  permissions: z.array(permissionKey),
});
export type Role = z.infer<typeof roleSchema>;

export const customRoleInput = z.object({
  name: z.string().trim().min(2).max(64),
  permissions: z
    .array(permissionKey)
    .min(1, "Select at least one permission")
    .max(PERMISSION_KEYS.length)
    .refine((keys) => new Set(keys).size === keys.length, "Permissions must be unique"),
});
export type CustomRoleInput = z.infer<typeof customRoleInput>;

export const updateCustomRoleInput = customRoleInput.extend({ id: uuid });
export type UpdateCustomRoleInput = z.infer<typeof updateCustomRoleInput>;
