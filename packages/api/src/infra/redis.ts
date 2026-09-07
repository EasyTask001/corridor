/**
 * Optional Upstash Redis, with a deterministic in-process fallback.
 *
 * Every cache/rate-limit call site talks to `KvStore` so the code path is the
 * same with and without Upstash configured. When `UPSTASH_REDIS_REST_URL` /
 * `UPSTASH_REDIS_REST_TOKEN` are absent `getRedis()` returns `null` and
 * `getKv()` hands back a module-level `MemoryKv` singleton.
 *
 * The memory fallback is per-process: it is NOT shared across serverless
 * instances (nor across `next dev` restarts), so in production without Upstash
 * every instance keeps its own counters. That is fine for local/dev/CI, which
 * is the only place it is meant to run.
 */
import { Redis } from "@upstash/redis";

/** The one interface every cache / rate-limit helper in `infra/` talks to. */
export interface KvStore {
  get<T>(key: string): Promise<T | null>;
  /** Store `value` for `ttlSeconds`. */
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  /** Increment (creating at 0 first) and return the new value. Never expires. */
  incr(key: string): Promise<number>;
}

interface MemoryEntry {
  value: unknown;
  /** Epoch ms, or `null` for "no expiry" (counters written by `incr`). */
  expiresAt: number | null;
}

/** Bound the map so a long-lived dev server cannot leak keys indefinitely. */
const MEMORY_SWEEP_THRESHOLD = 5_000;

/**
 * Minimal in-process `KvStore`. Single-threaded and synchronous under the
 * hood, so the read-modify-write in the memory rate limiter is effectively
 * atomic for sequential callers; two concurrent requests can interleave and
 * (at worst) allow one extra request through — acceptable for a local mode.
 */
export class MemoryKv implements KvStore {
  private readonly entries = new Map<string, MemoryEntry>();

  private read(key: string): MemoryEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  get<T>(key: string): Promise<T | null> {
    return Promise.resolve((this.read(key)?.value as T | undefined) ?? null);
  }

  set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (this.entries.size > MEMORY_SWEEP_THRESHOLD) this.sweep();
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  del(...keys: string[]): Promise<void> {
    for (const key of keys) this.entries.delete(key);
    return Promise.resolve();
  }

  incr(key: string): Promise<number> {
    const current = this.read(key);
    const next = (typeof current?.value === "number" ? current.value : 0) + 1;
    this.entries.set(key, { value: next, expiresAt: current?.expiresAt ?? null });
    return Promise.resolve(next);
  }

  /** Test helper — drops every key. */
  clear(): void {
    this.entries.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

class RedisKv implements KvStore {
  constructor(private readonly redis: Redis) {}

  get<T>(key: string): Promise<T | null> {
    return this.redis.get<T>(key);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, { ex: ttlSeconds });
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.redis.del(...keys);
  }

  incr(key: string): Promise<number> {
    return this.redis.incr(key);
  }
}

/** Shared across the process; see the file header for the caveat. */
const memoryKv = new MemoryKv();

let cachedRedis: Redis | null | undefined;
let cachedKv: KvStore | undefined;

/** The Upstash client, or `null` when the REST env vars are not configured. */
export function getRedis(): Redis | null {
  if (cachedRedis !== undefined) return cachedRedis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  cachedRedis = url && token ? new Redis({ url, token }) : null;
  return cachedRedis;
}

/** Redis-backed store when Upstash is configured, the memory singleton otherwise. */
export function getKv(): KvStore {
  if (cachedKv) return cachedKv;
  const redis = getRedis();
  cachedKv = redis ? new RedisKv(redis) : memoryKv;
  return cachedKv;
}

/** Test helper — forgets the memoised client and empties the memory store. */
export function resetKvForTests(): void {
  cachedRedis = undefined;
  cachedKv = undefined;
  memoryKv.clear();
}
