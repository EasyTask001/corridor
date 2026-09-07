/**
 * Short-lived cache of `current_user_permissions` per (user, org).
 *
 * RLS is still the tenant boundary — this only saves the extra RPC round-trip
 * on every request. Keys are scoped to `${orgId}:${userId}` so a cached set can
 * never be read by another tenant, and the TTL is short enough that a missed
 * invalidation self-heals within a minute.
 */
import type { PermissionKey } from "@corridor/domain";
import { getKv } from "./redis";

export const PERMISSION_CACHE_TTL_SECONDS = 60;

export function permissionCacheKey(orgId: string, userId: string): string {
  return `perms:${orgId}:${userId}`;
}

/** `null` on a miss (and on any cache error — the caller then hits the RPC). */
export async function getCachedPermissions(
  orgId: string,
  userId: string,
): Promise<PermissionKey[] | null> {
  try {
    return await getKv().get<PermissionKey[]>(permissionCacheKey(orgId, userId));
  } catch (error) {
    console.error("[permission-cache] read failed", error);
    return null;
  }
}

export async function cachePermissions(
  orgId: string,
  userId: string,
  permissions: readonly PermissionKey[],
): Promise<void> {
  try {
    await getKv().set(
      permissionCacheKey(orgId, userId),
      [...permissions],
      PERMISSION_CACHE_TTL_SECONDS,
    );
  } catch (error) {
    console.error("[permission-cache] write failed", error);
  }
}

/**
 * Drop the cached permission sets for the given users of an org. Called from
 * every mutation that can change what a member may do (role edits, membership
 * role/status changes, removals) so the change is visible on the next request
 * instead of up to a minute later.
 */
export async function invalidatePermissionCache(
  orgId: string,
  userIds: readonly (string | null | undefined)[],
): Promise<void> {
  const keys = [...new Set(userIds.filter((id): id is string => Boolean(id)))].map((userId) =>
    permissionCacheKey(orgId, userId),
  );
  if (keys.length === 0) return;
  try {
    await getKv().del(...keys);
  } catch (error) {
    console.error("[permission-cache] invalidation failed", error);
  }
}
