/**
 * HS / HTS tariff lookup stub — a small embedded table for the most common
 * cross-border commodities. The real HTS / CBSA Customs Tariff API adapter
 * replaces `lookupHsCode` later; the signature stays.
 *
 * Reads go through a small in-process TTL cache. Tariff schedules change a
 * couple of times a year, so a 24h TTL is generous; the cache exists so the
 * eventual HTTP adapter is not called once per rendered shipment line. tRPC
 * runs in this package (no Next.js runtime), so `unstable_cache` is not an
 * option — hence the plain Map. It is per process: a serverless instance warms
 * its own copy, which is exactly the blast radius we want for stale data.
 */
export interface TariffEntry {
  hsCode: string;
  description: string;
  /** general duty rate as a fraction, e.g. 0.025 = 2.5% */
  usDutyRate: number | null;
  caDutyRate: number | null;
  notes?: string;
  source: string;
  dataQuality: "synthetic_demo" | "authoritative";
  updatedAt: string;
  disclaimer: string | null;
}

const TABLE_UPDATED_AT = "2026-09-12T00:00:00.000Z";
const EXPERIMENTAL_DISCLAIMER = "Experimental — synthetic demo data, not live";

const TABLE: TariffEntry[] = (
  [
    {
      hsCode: "0808.10",
      description: "Apples, fresh",
      usDutyRate: 0,
      caDutyRate: 0,
      notes: "USMCA/CUSMA duty-free",
    },
    { hsCode: "0808.30", description: "Pears, fresh", usDutyRate: 0, caDutyRate: 0 },
    {
      hsCode: "4407.11",
      description: "Lumber, coniferous (pine), sawn",
      usDutyRate: 0,
      caDutyRate: 0,
      notes: "Softwood lumber duties may apply (AD/CVD)",
    },
    {
      hsCode: "7208.10",
      description: "Flat-rolled iron/steel, hot-rolled, in coils, with patterns in relief",
      usDutyRate: 0,
      caDutyRate: 0,
      notes: "Section 232 measures may apply",
    },
    {
      hsCode: "7210.49",
      description: "Flat-rolled iron/steel, zinc-plated (galvanized), other",
      usDutyRate: 0,
      caDutyRate: 0,
      notes: "Section 232 measures may apply",
    },
    {
      hsCode: "7308.90",
      description: "Structures and parts of iron or steel, other",
      usDutyRate: 0,
      caDutyRate: 0,
    },
    {
      hsCode: "8471.30",
      description: "Portable automatic data processing machines ≤10 kg",
      usDutyRate: 0,
      caDutyRate: 0,
    },
    {
      hsCode: "8708.99",
      description: "Parts and accessories of motor vehicles, other",
      usDutyRate: 0.025,
      caDutyRate: 0,
    },
    {
      hsCode: "3923.21",
      description: "Sacks and bags of polymers of ethylene",
      usDutyRate: 0.03,
      caDutyRate: 0,
    },
    { hsCode: "9403.60", description: "Wooden furniture, other", usDutyRate: 0, caDutyRate: 0 },
  ] satisfies Array<Omit<TariffEntry, "source" | "dataQuality" | "updatedAt" | "disclaimer">>
).map((entry) => ({
  ...entry,
  source: "Corridor embedded tariff demo",
  dataQuality: "synthetic_demo",
  updatedAt: TABLE_UPDATED_AT,
  disclaimer: EXPERIMENTAL_DISCLAIMER,
}));

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a lookup/search result stays fresh. 24h unless `TARIFF_CACHE_TTL_MS` overrides it. */
export const TARIFF_CACHE_TTL_MS = ttlFromEnv(process.env.TARIFF_CACHE_TTL_MS);

/** A malformed override must not silently disable caching (NaN expiry = always stale). */
function ttlFromEnv(raw: string | undefined): number {
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

/**
 * Cap on cached keys. `searchTariff` is keyed by a user-supplied query, so the
 * map is bounded and evicts oldest-first rather than growing without limit.
 */
const MAX_CACHE_ENTRIES = 500;

/**
 * The uncached table reads. Swappable so tests can count calls and so the real
 * HTS/CBSA adapter can be dropped in behind the same cache.
 */
export interface TariffSource {
  lookup(code: string): TariffEntry | null;
  search(query: string, limit: number): TariffEntry[];
}

const staticSource: TariffSource = {
  lookup: (c) =>
    TABLE.find((t) => t.hsCode === c) ?? TABLE.find((t) => c.startsWith(t.hsCode)) ?? null,
  search: (q, limit) =>
    TABLE.filter((t) => t.hsCode.startsWith(q) || t.description.toLowerCase().includes(q)).slice(
      0,
      limit,
    ),
};

let source: TariffSource = staticSource;
let now: () => number = () => Date.now();

interface CacheEntry {
  value: TariffEntry | TariffEntry[] | null;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/** Drop every cached entry. Tests call this; ops may call it after a schedule update. */
export function clearTariffCache(): void {
  cache.clear();
}

/**
 * Test seam: replace the underlying reads and/or the clock. Always clears the
 * cache so a configured test never sees entries from a previous one.
 */
export function configureTariffCache(opts: { source?: TariffSource; now?: () => number }): void {
  source = opts.source ?? staticSource;
  now = opts.now ?? (() => Date.now());
  clearTariffCache();
}

/** Restore the built-in table and the wall clock. */
export function resetTariffCache(): void {
  configureTariffCache({});
}

function cached<T extends TariffEntry | TariffEntry[] | null>(key: string, compute: () => T): T {
  const hit = cache.get(key);
  const t = now();
  if (hit && hit.expiresAt > t) return hit.value as T;
  const value = compute();
  cache.delete(key); // re-insert so Map iteration order stays "oldest first"
  cache.set(key, { value, expiresAt: t + TARIFF_CACHE_TTL_MS });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return value;
}

export function lookupHsCode(code: string | null | undefined): TariffEntry | null {
  if (!code) return null;
  const c = code.trim();
  if (!c) return null;
  return cached(`lookup:${c.toUpperCase()}`, () => source.lookup(c));
}

export function searchTariff(query: string, limit = 8): TariffEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return cached(`search:${limit}:${q}`, () => source.search(q, limit));
}
