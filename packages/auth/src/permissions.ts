import type { PermissionKey } from "@corridor/domain";

export class PermissionDeniedError extends Error {
  override readonly name = "PermissionDeniedError";
  constructor(public readonly permission: PermissionKey) {
    super(`Missing permission: ${permission}`);
  }
}

export function hasPermission(
  granted: ReadonlySet<PermissionKey> | readonly PermissionKey[],
  required: PermissionKey,
): boolean {
  return Array.isArray(granted)
    ? (granted as readonly PermissionKey[]).includes(required)
    : (granted as ReadonlySet<PermissionKey>).has(required);
}

export function hasAllPermissions(
  granted: ReadonlySet<PermissionKey>,
  required: readonly PermissionKey[],
): boolean {
  return required.every((p) => granted.has(p));
}

export function hasAnyPermission(
  granted: ReadonlySet<PermissionKey>,
  required: readonly PermissionKey[],
): boolean {
  return required.some((p) => granted.has(p));
}

export function assertPermission(
  granted: ReadonlySet<PermissionKey>,
  required: PermissionKey,
): void {
  if (!granted.has(required)) throw new PermissionDeniedError(required);
}
