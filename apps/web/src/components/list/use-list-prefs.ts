"use client";

/**
 * Per-list preferences (Task 14): visible columns, page size and the
 * auto-refresh interval, remembered in this browser under
 * `corridor.list.<name>`. Read through an external store so the server render
 * uses the defaults and the stored choice lands after hydration.
 */
import { useCallback, useSyncExternalStore } from "react";

export interface ListPrefs {
  columns: string[];
  pageSize: number;
  autoRefreshSec: number;
}

export const PAGE_SIZES = [10, 25, 50, 100, 200] as const;
export const REFRESH_INTERVALS = [0, 30, 60, 300] as const;

/** Parse a stored value, keeping only what is valid and falling back per field. */
export function parseListPrefs(raw: string | null, defaults: ListPrefs, validColumns: readonly string[]): ListPrefs {
  if (!raw) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn("[prefs] could not read list preferences; using defaults", e);
    return defaults;
  }
  if (!parsed || typeof parsed !== "object") return defaults;
  const p = parsed as Partial<Record<keyof ListPrefs, unknown>>;
  const columns = Array.isArray(p.columns)
    ? validColumns.filter((c) => (p.columns as unknown[]).includes(c))
    : defaults.columns;
  const pageSize = (PAGE_SIZES as readonly number[]).includes(p.pageSize as number) ? (p.pageSize as number) : defaults.pageSize;
  const autoRefreshSec = (REFRESH_INTERVALS as readonly number[]).includes(p.autoRefreshSec as number)
    ? (p.autoRefreshSec as number)
    : defaults.autoRefreshSec;
  return { columns: columns.length > 0 ? columns : defaults.columns, pageSize, autoRefreshSec };
}

const keyFor = (name: string) => `corridor.list.${name}`;
const listeners = new Map<string, Set<() => void>>();
const cache = new Map<string, { raw: string | null; prefs: ListPrefs }>();

function read(name: string, defaults: ListPrefs, validColumns: readonly string[]): ListPrefs {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(keyFor(name));
  } catch (e) {
    console.warn("[prefs] could not read list preferences; using defaults", e);
    raw = null;
  }
  const hit = cache.get(name);
  if (hit && hit.raw === raw) return hit.prefs;
  const prefs = parseListPrefs(raw, defaults, validColumns);
  cache.set(name, { raw, prefs });
  return prefs;
}

function write(name: string, prefs: ListPrefs) {
  const raw = JSON.stringify(prefs);
  try {
    window.localStorage.setItem(keyFor(name), raw);
  } catch (e) {
    console.warn("[prefs] could not save list preferences (private browsing?)", e);
  }
  cache.set(name, { raw, prefs });
  listeners.get(name)?.forEach((cb) => cb());
}

export function useListPrefs(name: string, defaults: ListPrefs, validColumns: readonly string[]) {
  const subscribe = useCallback(
    (cb: () => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(cb);
      listeners.set(name, set);
      window.addEventListener("storage", cb);
      return () => {
        set.delete(cb);
        window.removeEventListener("storage", cb);
      };
    },
    [name],
  );
  const prefs = useSyncExternalStore(
    subscribe,
    () => read(name, defaults, validColumns),
    () => defaults,
  );
  const update = useCallback((patch: Partial<ListPrefs>) => write(name, { ...read(name, defaults, validColumns), ...patch }), [name, defaults, validColumns]);
  return [prefs, update] as const;
}
