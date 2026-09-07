import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionKey } from "@corridor/domain";
import {
  cachePermissions,
  getCachedPermissions,
  invalidatePermissionCache,
  permissionCacheKey,
  PERMISSION_CACHE_TTL_SECONDS,
} from "./infra/permission-cache";
import {
  RATE_LIMITS,
  RateLimitExceededError,
  rateLimitFor,
  rateLimitKey,
  rateLimitMultiplier,
  type RateLimitIdentity,
} from "./infra/ratelimit";
import { getKv, getRedis, MemoryKv, resetKvForTests } from "./infra/redis";
import { withPermissionInvalidation } from "./router/organization";
import type { RlsTransaction } from "@corridor/db";
import type { OrgContext } from "./trpc";

/**
 * The whole suite runs against the in-memory fallback: no `UPSTASH_*` env is
 * set, so `getRedis()` is null and `getKv()` hands back the `MemoryKv`
 * singleton. `CORRIDOR_RATELIMIT_MULTIPLIER=1` pins the limits to the exact
 * per-plan numbers (the default of 10 outside production only exists so a local
 * Playwright run cannot trip them).
 */
beforeEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.CORRIDOR_RATELIMIT_MULTIPLIER = "1";
  resetKvForTests();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CORRIDOR_RATELIMIT_MULTIPLIER;
  resetKvForTests();
});

describe("MemoryKv", () => {
  it("expires values after their ttl", async () => {
    vi.useFakeTimers();
    const kv = new MemoryKv();
    await kv.set("k", { a: 1 }, 60);
    await expect(kv.get("k")).resolves.toEqual({ a: 1 });
    vi.advanceTimersByTime(59_000);
    await expect(kv.get("k")).resolves.toEqual({ a: 1 });
    vi.advanceTimersByTime(2_000);
    await expect(kv.get("k")).resolves.toBeNull();
  });

  it("increments counters from zero and deletes keys", async () => {
    const kv = new MemoryKv();
    await expect(kv.incr("v")).resolves.toBe(1);
    await expect(kv.incr("v")).resolves.toBe(2);
    await kv.del("v");
    await expect(kv.get("v")).resolves.toBeNull();
  });
});

describe("rate limiting (memory fallback)", () => {
  const userA: RateLimitIdentity = { orgId: "org-1", userId: "user-a" };
  const userB: RateLimitIdentity = { orgId: "org-1", userId: "user-b" };

  it("uses the memory store when Upstash is not configured", () => {
    expect(getRedis()).toBeNull();
    expect(getKv()).toBeInstanceOf(MemoryKv);
  });

  it("keys `standard` per user in the org and `ai` per org", () => {
    expect(rateLimitKey("standard", { orgId: "org-1", userId: "user-a" })).toBe(
      "standard:org-1:user-a",
    );
    expect(rateLimitKey("standard", { orgId: "org-1", userId: "user-b" })).toBe(
      "standard:org-1:user-b",
    );
    expect(rateLimitKey("ai", { orgId: "org-1", userId: "user-a" })).toBe("ai:org-1");
    expect(rateLimitKey("ai", { orgId: "org-1", userId: "user-b" })).toBe("ai:org-1");
    // Onboarding: no org yet, so both tiers fall back to the user.
    expect(rateLimitKey("standard", { orgId: null, userId: "user-a" })).toBe(
      "standard:user:user-a",
    );
    expect(rateLimitKey("ai", { orgId: null, userId: "user-a" })).toBe("ai:user:user-a");
  });

  it("allows exactly `limit` requests and rejects the next one", async () => {
    const limiter = rateLimitFor("standard", "trial");
    expect(limiter.limit).toBe(RATE_LIMITS.standard.trial);

    for (let i = 0; i < limiter.limit; i++) {
      const result = await limiter.check(userA);
      expect(result.success).toBe(true);
      expect(result.remaining).toBe(limiter.limit - (i + 1));
    }

    const denied = await limiter.check(userA);
    expect(denied.success).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("gives each user in the org their own `standard` window", async () => {
    const limiter = rateLimitFor("standard", "trial");
    for (let i = 0; i < limiter.limit; i++) {
      expect((await limiter.check(userA)).success).toBe(true);
    }
    // user-a is locked out …
    expect((await limiter.check(userA)).success).toBe(false);
    // … their colleague in the same org is not.
    expect((await limiter.check(userB)).success).toBe(true);
  });

  it("shares one `ai` window across the whole org", async () => {
    const ai = rateLimitFor("ai", "trial");
    for (let i = 0; i < ai.limit; i++) {
      expect((await ai.check(userA)).success).toBe(true);
    }
    // The org's AI budget is spent, so a colleague is refused too.
    expect((await ai.check(userB)).success).toBe(false);
    // Another org is untouched.
    expect((await ai.check({ orgId: "org-2", userId: "user-a" })).success).toBe(true);
  });

  it("counts the two tiers separately", async () => {
    const standard = rateLimitFor("standard", "trial");
    const ai = rateLimitFor("ai", "trial");

    for (let i = 0; i < ai.limit; i++) {
      expect((await ai.check(userA)).success).toBe(true);
    }
    expect((await ai.check(userA)).success).toBe(false);
    expect((await standard.check(userA)).success).toBe(true);
  });

  it("slides the window rather than resetting on a fixed boundary", async () => {
    vi.useFakeTimers();
    const limiter = rateLimitFor("ai", "trial");

    for (let i = 0; i < limiter.limit; i++) {
      expect((await limiter.check(userA)).success).toBe(true);
      vi.advanceTimersByTime(1_000);
    }
    expect((await limiter.check(userA)).success).toBe(false);

    // Half a window later the earliest hits have not yet aged out.
    vi.advanceTimersByTime(30_000);
    expect((await limiter.check(userA)).success).toBe(false);

    // Past the first hit's 60s window, one slot frees up at a time.
    vi.advanceTimersByTime(25_500);
    expect((await limiter.check(userA)).success).toBe(true);
    expect((await limiter.check(userA)).success).toBe(false);
  });

  it("tiers the limits by plan", async () => {
    expect(rateLimitFor("standard", "trial").limit).toBe(60);
    expect(rateLimitFor("standard", "starter").limit).toBe(120);
    expect(rateLimitFor("standard", "professional").limit).toBe(300);
    expect(rateLimitFor("standard", "enterprise").limit).toBe(600);
    expect(rateLimitFor("ai", "trial").limit).toBe(5);
    expect(rateLimitFor("ai", "starter").limit).toBe(20);
    expect(rateLimitFor("ai", "professional").limit).toBe(60);
    expect(rateLimitFor("ai", "enterprise").limit).toBe(120);

    // An enterprise org gets through more than a trial org would.
    const enterprise = rateLimitFor("ai", "enterprise");
    for (let i = 0; i < RATE_LIMITS.ai.trial + 1; i++) {
      expect((await enterprise.check(userA)).success).toBe(true);
    }
  });

  it("multiplies the fallback limits outside production", () => {
    delete process.env.CORRIDOR_RATELIMIT_MULTIPLIER;
    expect(rateLimitMultiplier()).toBe(10);
    expect(rateLimitFor("ai", "trial").limit).toBe(RATE_LIMITS.ai.trial * 10);

    process.env.CORRIDOR_RATELIMIT_MULTIPLIER = "3";
    expect(rateLimitFor("standard", "trial").limit).toBe(RATE_LIMITS.standard.trial * 3);
  });

  it("carries the retry hint on the error thrown by the middleware", () => {
    const error = new RateLimitExceededError("ai", "trial", 5, 42);
    expect(error).toBeInstanceOf(Error);
    expect(error.retryAfterSeconds).toBe(42);
    expect(error.message).toContain("trial");
  });
});

describe("permission cache", () => {
  const orgId = "11111111-1111-1111-1111-111111111111";
  const otherOrgId = "22222222-2222-2222-2222-222222222222";
  const userA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const userB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const keys: PermissionKey[] = ["movement.read", "movement.write"];

  it("scopes the key to the org and the user", () => {
    expect(permissionCacheKey(orgId, userA)).toBe(`perms:${orgId}:${userA}`);
    expect(permissionCacheKey(orgId, userA)).not.toBe(permissionCacheKey(otherOrgId, userA));
    expect(permissionCacheKey(orgId, userA)).not.toBe(permissionCacheKey(orgId, userB));
  });

  it("misses, then hits, then expires after the ttl", async () => {
    vi.useFakeTimers();
    await expect(getCachedPermissions(orgId, userA)).resolves.toBeNull();
    await cachePermissions(orgId, userA, keys);
    await expect(getCachedPermissions(orgId, userA)).resolves.toEqual(keys);
    vi.advanceTimersByTime(PERMISSION_CACHE_TTL_SECONDS * 1000 + 1);
    await expect(getCachedPermissions(orgId, userA)).resolves.toBeNull();
  });

  it("caches an empty permission set as a hit, not a miss", async () => {
    await cachePermissions(orgId, userA, []);
    await expect(getCachedPermissions(orgId, userA)).resolves.toEqual([]);
  });

  it("invalidates only the listed users of the given org", async () => {
    await cachePermissions(orgId, userA, keys);
    await cachePermissions(orgId, userB, keys);
    await cachePermissions(otherOrgId, userA, keys);

    await invalidatePermissionCache(orgId, [userA, null, undefined, userA]);

    await expect(getCachedPermissions(orgId, userA)).resolves.toBeNull();
    await expect(getCachedPermissions(orgId, userB)).resolves.toEqual(keys);
    await expect(getCachedPermissions(otherOrgId, userA)).resolves.toEqual(keys);

    await invalidatePermissionCache(orgId, [userA, userB]);
    await expect(getCachedPermissions(orgId, userB)).resolves.toBeNull();
    await expect(getCachedPermissions(otherOrgId, userA)).resolves.toEqual(keys);
  });

  it("is a no-op when there is nothing to invalidate", async () => {
    await cachePermissions(orgId, userA, keys);
    await invalidatePermissionCache(orgId, [null, undefined]);
    await expect(getCachedPermissions(orgId, userA)).resolves.toEqual(keys);
  });

  describe("withPermissionInvalidation", () => {
    /** Minimal stand-in for the one `select ... from organization_members` it runs. */
    function fakeTx(memberUserIds: (string | null)[]): RlsTransaction {
      return {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(memberUserIds.map((userId) => ({ userId }))),
          }),
        }),
      } as unknown as RlsTransaction;
    }

    /**
     * `rls` stands in for the transaction: it records when the callback has
     * resolved (i.e. the tx is about to commit) and what the cache looked like
     * at that moment.
     */
    function fakeCtx(
      memberUserIds: (string | null)[],
      order: string[],
      atCommit: { cached?: PermissionKey[] | null } = {},
    ): OrgContext {
      return {
        orgId,
        rls: async <T>(fn: (tx: RlsTransaction) => Promise<T>): Promise<T> => {
          order.push("tx:begin");
          const value = await fn(fakeTx(memberUserIds));
          atCommit.cached = await getCachedPermissions(orgId, userA);
          order.push("tx:commit");
          return value;
        },
      } as unknown as OrgContext;
    }

    it("invalidates only after the transaction callback resolves", async () => {
      await cachePermissions(orgId, userA, keys);
      const order: string[] = [];
      const atCommit: { cached?: PermissionKey[] | null } = {};

      const result = await withPermissionInvalidation(
        fakeCtx([userA], order, atCommit),
        async () => {
          order.push("mutation");
          return "saved" as const;
        },
      );

      expect(result).toBe("saved");
      expect(order).toEqual(["tx:begin", "mutation", "tx:commit"]);
      // Still cached while the transaction was open — the delete had not run …
      expect(atCommit.cached).toEqual(keys);
      // … and gone once it committed.
      await expect(getCachedPermissions(orgId, userA)).resolves.toBeNull();
    });

    it("invalidates every member plus the ids the mutation queues", async () => {
      await cachePermissions(orgId, userA, keys);
      await cachePermissions(orgId, userB, keys);
      await cachePermissions(otherOrgId, userA, keys);

      // userB has just been removed, so the post-mutation member list omits them.
      await withPermissionInvalidation(fakeCtx([userA], []), async (_tx, alsoInvalidate) => {
        alsoInvalidate(userB);
      });

      await expect(getCachedPermissions(orgId, userA)).resolves.toBeNull();
      await expect(getCachedPermissions(orgId, userB)).resolves.toBeNull();
      await expect(getCachedPermissions(otherOrgId, userA)).resolves.toEqual(keys);
    });

    it("leaves the cache alone when the mutation throws", async () => {
      await cachePermissions(orgId, userA, keys);
      await expect(
        withPermissionInvalidation(fakeCtx([userA], []), async () => {
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");
      await expect(getCachedPermissions(orgId, userA)).resolves.toEqual(keys);
    });
  });
});
