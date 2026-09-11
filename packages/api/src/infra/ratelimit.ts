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
import { getKv, getMemoryKv, getRedis, type KvStore } from "./redis";

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
  /**
   * Counter key to use instead of the derived one. For the handful of public
   * endpoints that have no session to count against and must therefore count
   * by IP — `GET /api/auth/sso`, keyed `sso:ip:<ip>`. Never set it for an
   * authenticated caller: the derived key is what keeps one tenant out of
   * another tenant's window.
   */
  key?: string;
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
 * - an explicit `identity.key` wins over both (sessionless public endpoints).
 *
 * With no active org (onboarding) both fall back to `${tier}:user:${userId}`.
 * A derived key always starts with the tier and contains the org id, so a
 * tenant can never be counted against another tenant's window; an explicit key
 * belongs to a caller that has no tenant yet, and carries its own prefix.
 */
export function rateLimitKey(tier: RateLimitTier, identity: RateLimitIdentity): string {
  if (identity.key) return identity.key;
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

type LimiterLike = Pick<Ratelimit, "limit">;
let limiterFactoryOverride:
  | ((tier: RateLimitTier, plan: SubscriptionPlan, limit: number) => LimiterLike)
  | null = null;

/** Test seam: replace the Upstash limiter (e.g. with one that throws). */
export function _setUpstashLimiterFactoryForTests(factory: typeof limiterFactoryOverride): void {
  limiterFactoryOverride = factory;
  upstashLimiters.clear();
}

function upstashLimiter(tier: RateLimitTier, plan: SubscriptionPlan, limit: number): LimiterLike {
  if (limiterFactoryOverride) return limiterFactoryOverride(tier, plan, limit);
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
 * Falls back to the in-process window: if Redis is unreachable the request is
 * counted against the per-instance `MemoryKv` sliding window (the same one
 * used when Upstash isn't configured at all) rather than either allowing
 * everything through or turning a cache outage into an outage of the whole
 * API.
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
        // A cache outage must not become an API outage, but neither should it
        // remove the ceiling: fall back to the per-instance sliding window.
        console.error("[ratelimit] store unavailable; counting in-process", error);
        return checkWithKv(getMemoryKv(), `rl:fallback:${key}`, limit, RATE_LIMIT_WINDOW_SECONDS);
      }
    },
  };
}

/**
 * Fixed-ceiling limiter for sessionless public endpoints (0027): counted by an
 * explicit key (a hashed IP), with a window of the caller's choosing and no
 * plan multiplier — a public page has no plan. Same sliding window, same
 * in-process fallback policy as the plan limiters.
 */
export async function checkPublicRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const redis = getRedis();
  try {
    if (!redis) return await checkWithKv(getKv(), `rl:public:${key}:${windowSeconds}`, limit, windowSeconds);
    const cacheKey = `public:${limit}:${windowSeconds}`;
    let limiter = upstashLimiters.get(cacheKey);
    if (!limiter) {
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
        prefix: "corridor:rl:public",
        analytics: false,
      });
      upstashLimiters.set(cacheKey, limiter);
    }
    const result = await limiter.limit(key);
    if (result.success) return allowed(result.limit, result.remaining);
    return {
      success: false,
      limit: result.limit,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
    };
  } catch (error) {
    console.error("[ratelimit] public store unavailable; counting in-process", error);
    return checkWithKv(getMemoryKv(), `rl:public:fallback:${key}:${windowSeconds}`, limit, windowSeconds);
  }
}