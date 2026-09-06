import { describe, expect, it } from "vitest";
import {
  PermissionDeniedError,
  assertPermission,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
} from "./permissions";
import { extractBearer } from "./session";

const granted = new Set(["movement.read", "movement.write"] as const);

describe("permission helpers", () => {
  it("hasPermission works with sets and arrays", () => {
    expect(hasPermission(granted, "movement.read")).toBe(true);
    expect(hasPermission(["movement.read"], "movement.read")).toBe(true);
    expect(hasPermission(granted, "movement.transmit_to_customs")).toBe(false);
  });

  it("all/any", () => {
    expect(hasAllPermissions(granted, ["movement.read", "movement.write"])).toBe(true);
    expect(hasAllPermissions(granted, ["movement.read", "billing.manage"])).toBe(false);
    expect(hasAnyPermission(granted, ["billing.manage", "movement.write"])).toBe(true);
  });

  it("assertPermission throws a typed error", () => {
    expect(() => assertPermission(granted, "billing.manage")).toThrow(PermissionDeniedError);
    expect(() => assertPermission(granted, "movement.read")).not.toThrow();
  });
});

describe("extractBearer", () => {
  it("parses Authorization headers case-insensitively", () => {
    expect(extractBearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearer("bearer xyz")).toBe("xyz");
    expect(extractBearer("Basic xyz")).toBeNull();
    expect(extractBearer(null)).toBeNull();
  });
});
