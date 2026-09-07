/**
 * Per-plan sliding-window rate limiting.
 *
 * With Upstash configured the counting is done by `@upstash/ratelimit`
 * (shared across instances). Without it, the same sliding window runs against
 * the in-process `MemoryKv` — see `rateLimitMultiplier()` for why the local
 * limits are deliberately looser.
 *
 * The two tiers are counted at different granularities (see `rateLimitKey`):
 * `standard` is per user **within** the org, so one busy colleague cannot lock
 * the whole tenant out of ordinary reads and writes; `ai` is per org, because
 * model spend is an org-level plan resource that the whole tenant shares. The
 * per-plan ceilings apply to whichever counter the tier uses.
 *
 * The `ai` tier is for procedures that **invoke a model or enqueue model work**
 * — its ceilings exist to cap token spend, not request volume. A procedure that
 * is merely expensive, or that only looks AI-shaped (a deterministic
 * question-to-DSL translation, say), belongs on `standard`.
 */
import { Ratelimit, type Duration } from "@upstash/ratelimit";
import type { SubscriptionPlan } from "@corridor/domain";
import { getKv, getRedis, type KvStore } from "./redis";

export type RateLimitTier = "standard" | "ai";

/** Requests allowed per minute, per tier and plan. */
export const RATE_LIMITS: Record<RateLimitTier, Record<SubscriptionPlan, number>> = {
  standard: { trial: 60, starter: 120, professional: 300, enterprise: 600 },
  ai: { trial: 5, starter: 20, professional: 60, enterprise: 120 },
};

export const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_WINDOW: Duration = "60 s";

export interface RateLimitResult {
  success: boolean;
  /** The effective limit for the window (already multiplied, if applicable). */
  limit: number;
  remaining: number;
  /** Seconds until the caller may retry. `0` when the request was allowed. */
  retryAfterSeconds: number;
}

/** Who a request is counted against. `orgId` is null before onboarding. */
export interface RateLimitIdentity {
  orgId: string | null;
  userId: string;
}

export interface RateLimiter {
  readonly tier: RateLimitTier;
  readonly plan: SubscriptionPlan;
  readonly limit: number;
  readonly windowSeconds: number;
  check(identity: RateLimitIdentity): Promise<RateLimitResult>;
}

/**
 * The counter key.
 *
 * - `standard` → `standard:${orgId}:${userId}` (per user within the org).
 * - `ai`       → `ai:${orgId}` (per org — shared model budget).
 *
 * With no active org (onboarding) both fall back to `${tier}:user:${userId}`.
 * Keys always start with the tier and contain the org id, so a tenant can never
 * be counted against another tenant's window.
 */
export function rateLimitKey(tier: RateLimitTier, identity: RateLimitIdentity): string {
  if (!identity.orgId) return `${tier}:user:${identity.userId}`;
  return tier === "ai" ? `ai:${identity.orgId}` : `standard:${identity.orgId}:${identity.userId}`;
}

/** Thrown as the `cause` of the `TOO_MANY_REQUESTS` tRPC error. */
export class RateLimitExceededError extends Error {
  override readonly name = "RateLimitExceededError";

  constructor(
    readonly tier: RateLimitTier,
    readonly plan: SubscriptionPlan,
    readonly limit: number,
    readonly retryAfterSeconds: number,
  ) {
    super(
      `Rate limit of ${limit} requests/minute (${tier}, ${plan} plan) exceeded. ` +
        `Retry in ${retryAfterSeconds}s.`,
    );
  }
}

/**
 * Multiplier applied to the plan limits **only** when Upstash is absent and the
 * in-memory fallback is doing the counting. Production keeps the plan's exact
 * numbers; local dev / Playwright would otherwise trip the trial limits during
 * a normal test run (one process serves every request for the one seeded org).
 * Override with `CORRIDOR_RATELIMIT_MULTIPLIER`.
 */
export function rateLimitMultiplier(): number {
  const configured = Number(process.env.CORRIDOR_RATELIMIT_MULTIPLIER);
  if (Number.isFinite(configured) && configured >= 1) return Math.floor(configured);
  return process.env.NODE_ENV === "production" ? 1 : 10;
}

const upstashLimiters = new Map<string, Ratelimit>();

function upstashLimiter(tier: RateLimitTier, plan: SubscriptionPlan, limit: number): Ratelimit {
  const cacheKey = `${tier}:${plan}:${limit}`;
  const existing = upstashLimiters.get(cacheKey);
  if (existing) return existing;
  const created = new Ratelimit({
    // Non-null: only called when `getRedis()` returned a client.
    redis: getRedis()!,
    limiter: Ratelimit.slidingWindow(limit, RATE_LIMIT_WINDOW),
    prefix: "corridor:rl",
    analytics: false,
  });
  upstashLimiters.set(cacheKey, created);
  return created;
}

function allowed(limit: number, remaining: number): RateLimitResult {
  return { success: true, limit, remaining, retryAfterSeconds: 0 };
}

/**
 * Sliding-window log on the KV store. Keeps the hit timestamps inside the
 * window under one key so the window slides rather than resetting on the
 * minute boundary.
 */
async function checkWithKv(
  kv: KvStore,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const hits = (await kv.get<number[]>(key)) ?? [];
  const live = hits.filter((at) => at > now - windowMs);

  if (live.length >= limit) {
    const oldest = live[0] ?? now;
    await kv.set(key, live, windowSeconds);
    return {
      success: false,
      limit,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  live.push(now);
  await kv.set(key, live, windowSeconds);
  return allowed(limit, limit - live.length);
}

/**
 * Sliding-window limiter for a tier/plan pair. The plan only selects the
 * ceiling — it is not part of the key — so a plan change takes effect on the
 * next request without resetting the window.
 *
 * Fails open: if Redis is unreachable the request is allowed rather than
 * turning a cache outage into an outage of the whole API.
 */
export function rateLimitFor(tier: RateLimitTier, plan: SubscriptionPlan): RateLimiter {
  const redis = getRedis();
  const base = RATE_LIMITS[tier][plan];
  const limit = redis ? base : base * rateLimitMultiplier();

  return {
    tier,
    plan,
    limit,
    windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    async check(identity: RateLimitIdentity): Promise<RateLimitResult> {
      const key = rateLimitKey(tier, identity);
      try {
        if (!redis)
          return await checkWithKv(getKv(), `rl:${key}`, limit, RATE_LIMIT_WINDOW_SECONDS);
        const result = await upstashLimiter(tier, plan, limit).limit(key);
        if (result.success) return allowed(result.limit, result.remaining);
        return {
          success: false,
          limit: result.limit,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
        };
      } catch (error) {
        console.error("[ratelimit] check failed; allowing request", error);
        return allowed(limit, limit);
      }
    },
  };
}
