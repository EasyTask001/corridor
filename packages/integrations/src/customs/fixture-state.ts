/**
 * Process-local state for the two offline customs gateways (the mock and the
 * fixture replay). Both must remember a filing between calls so a poll
 * sequence unfolds like a real crossing, but the API builds a fresh client per
 * request (`customsClientFor`), so per-instance Maps forgot every filing
 * (ISSUE-003/016) and the module-level bond Maps were shared across tenants
 * (ISSUE-004). Every store here is keyed by tenant, bounded (LRU) and expiring
 * (TTL), modelled on the tariff cache in ../tariff.ts.
 */
import type { Regime } from "@corridor/domain";
import type { InBondStatusMessage, ManifestPayload } from "./types";

export interface FixtureStore<T> {
  get(tenant: string, key: string): T | undefined;
  set(tenant: string, key: string, value: T): void;
  delete(tenant: string, key: string): void;
  clear(): void;
  readonly size: number;
}

export function createFixtureStore<T>(opts: {
  maxEntries: number;
  ttlMs: number;
  now?: () => number;
}): FixtureStore<T> {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const now = opts.now ?? (() => Date.now());
  //  (unit separator) cannot appear in a uuid or a reference number, so
  // "tenantA" + "1:x" can never collide with "tenantA1" + ":x".
  const k = (tenant: string, key: string) => `${tenant}${key}`;
  const evict = () => {
    while (entries.size > opts.maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  };
  return {
    get(tenant, key) {
      const id = k(tenant, key);
      const hit = entries.get(id);
      if (!hit) return undefined;
      if (hit.expiresAt <= now()) {
        entries.delete(id);
        return undefined;
      }
      entries.delete(id); // re-insert: Map order stays least-recently-used first
      entries.set(id, hit);
      return hit.value;
    },
    set(tenant, key, value) {
      const id = k(tenant, key);
      entries.delete(id);
      entries.set(id, { value, expiresAt: now() + opts.ttlMs });
      evict();
    },
    delete(tenant, key) {
      entries.delete(k(tenant, key));
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

export interface GatewayFiling {
  outcome: "accepted" | "held" | "rejected";
  controlNumbers: string[];
  portOfEntry: string | null;
  polls: number;
}
export interface MockFiling {
  manifest: ManifestPayload;
  stage: "sent" | "accepted" | "held" | "done";
  cancelled: boolean;
}
export type GatewayBondStatus = "arrived" | "exported" | "cancelled";

/** A filing is polled for at most 48h (services/customs.ts POLL_WINDOW_MS); keep it a little longer. */
const FILING_TTL_MS = 72 * 60 * 60 * 1000;
const BOND_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const gatewayFilings = createFixtureStore<GatewayFiling>({
  maxEntries: 5_000,
  ttlMs: FILING_TTL_MS,
});
export const gatewayBonds = createFixtureStore<GatewayBondStatus>({
  maxEntries: 5_000,
  ttlMs: BOND_TTL_MS,
});
export const mockFiled = createFixtureStore<MockFiling>({
  maxEntries: 5_000,
  ttlMs: FILING_TTL_MS,
});
export const mockBonds = createFixtureStore<InBondStatusMessage["status"]>({
  maxEntries: 5_000,
  ttlMs: BOND_TTL_MS,
});

/**
 * The fixture BorderConnect transport's inbox: one queue of not-yet-drained
 * inbound messages per tenant (`borderconnect/client.ts`'s
 * `createFixtureBorderConnectTransport`). `send()` appends to it, `receive()`
 * drains it — the same "poll the shared queue" shape a live `GET
 * /api/receive` call has, just in-process.
 */
export const borderConnectQueue = createFixtureStore<Record<string, unknown>[]>({
  maxEntries: 5_000,
  ttlMs: FILING_TTL_MS,
});

/** Per tenant+regime reference counters: two instances of one tenant never hand out the same reference. */
const sequences = new Map<string, number>();
export function nextFixtureSequence(tenant: string, regime: Regime): number {
  const key = `${tenant}${regime}`;
  const next = (sequences.get(key) ?? 0) + 1;
  sequences.set(key, next);
  return next;
}

/** Drop every filing, bond and counter. Tests call this in `beforeEach`. */
export function clearCustomsFixtureState(): void {
  gatewayFilings.clear();
  gatewayBonds.clear();
  mockFiled.clear();
  mockBonds.clear();
  borderConnectQueue.clear();
  sequences.clear();
}
