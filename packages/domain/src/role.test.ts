import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS, PERMISSIONS } from "./permission";
import { SYSTEM_ROLES, SYSTEM_ROLE_PERMISSIONS, type SystemRoleKey } from "./role";

describe("system role grants", () => {
  it("every system role has a permission list", () => {
    for (const key of Object.keys(SYSTEM_ROLES) as SystemRoleKey[]) {
      expect(SYSTEM_ROLE_PERMISSIONS[key]).toBeDefined();
    }
  });

  it("only grants known permission keys", () => {
    for (const grants of Object.values(SYSTEM_ROLE_PERMISSIONS)) {
      for (const g of grants) expect(PERMISSIONS[g]).toBeDefined();
    }
  });

  it("owner has every permission; admin has everything but billing.manage", () => {
    expect(new Set(SYSTEM_ROLE_PERMISSIONS.owner)).toEqual(new Set(PERMISSION_KEYS));
    expect(SYSTEM_ROLE_PERMISSIONS.admin).not.toContain("billing.manage");
    expect(SYSTEM_ROLE_PERMISSIONS.admin).toHaveLength(PERMISSION_KEYS.length - 1);
  });

  it("read-only cannot transmit to customs or write anything", () => {
    for (const g of SYSTEM_ROLE_PERMISSIONS.read_only) {
      expect(g.endsWith(".read")).toBe(true);
    }
    expect(SYSTEM_ROLE_PERMISSIONS.read_only).not.toContain("movement.transmit_to_customs");
  });

  it("driver portal is a minimal, mobile-scoped set", () => {
    expect(SYSTEM_ROLE_PERMISSIONS.driver_portal).toEqual([
      "movement.read_assigned",
      "document.upload",
    ]);
  });
});
