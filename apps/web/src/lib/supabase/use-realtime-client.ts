"use client";

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "./client";
import { REFRESH_LEAD_MS, getRealtimeToken } from "./realtime-token";

/** Never schedule a refresh sooner than this (guards clock skew / a short JWT). */
const MIN_REFRESH_MS = 10_000;
/** Backoff after a failed token fetch (offline, or a 401 during sign-out). */
const RETRY_MS = 30_000;

/**
 * A Supabase browser client whose Realtime socket is authenticated as the
 * current user.
 *
 * The session cookies are httpOnly (by design), so `createBrowserClient` has no
 * session and its socket would connect as `anon` — every `postgres_changes`
 * subscription then silently emptied by RLS (`to authenticated`). This hook
 * fetches the short-lived access token from `/api/realtime/token`, pushes it
 * into the socket with `realtime.setAuth()`, and re-fetches a minute before the
 * JWT expires so a long-lived tab keeps receiving rows.
 *
 * Returns `null` until the socket is authenticated — callers must not subscribe
 * before then, or they subscribe as `anon` and get nothing.
 */
export function useRealtimeClient(): SupabaseClient | null {
  const [client, setClient] = useState<SupabaseClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (ms: number) => {
      if (cancelled) return;
      timer = setTimeout(() => void authenticate(true), ms);
    };

    async function authenticate(force = false) {
      const current = await getRealtimeToken(force);
      if (cancelled) return;
      if (!current) {
        schedule(RETRY_MS);
        return;
      }

      const supabase = createSupabaseBrowserClient();
      await supabase.realtime.setAuth(current.token);
      if (cancelled) return;

      setClient(supabase);
      schedule(Math.max(MIN_REFRESH_MS, current.expiresAt - Date.now() - REFRESH_LEAD_MS));
    }

    void authenticate();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return client;
}
