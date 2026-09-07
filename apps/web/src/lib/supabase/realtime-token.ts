"use client";

/**
 * The browser's copy of the caller's Supabase access token, fetched from
 * `/api/realtime/token` (the session cookies are httpOnly, so the browser
 * client cannot read the session itself — see that route for why handing out
 * the access token is safe).
 *
 * Module-level, not per-hook: `realtime-js` asks for the token again on every
 * connect and heartbeat, and every subscribing component shares one socket, so
 * the fetch has to be shared and de-duplicated too.
 */

/** Refresh this long before the JWT expires. */
export const REFRESH_LEAD_MS = 60_000;

export interface RealtimeToken {
  token: string;
  expiresAt: number;
}

let cached: RealtimeToken | null = null;
let inflight: Promise<RealtimeToken | null> | null = null;

/**
 * The current token, fetching one if there is none or the cached one is inside
 * its refresh window. Concurrent callers share a single request. On failure the
 * previous token is kept (it is probably still valid) and `null` is returned
 * only when there has never been one.
 */
export async function getRealtimeToken(force = false): Promise<RealtimeToken | null> {
  if (!force && cached && cached.expiresAt - Date.now() > REFRESH_LEAD_MS) return cached;
  if (!inflight) {
    const request = load();
    inflight = request;
    void request.finally(() => {
      if (inflight === request) inflight = null;
    });
  }
  return inflight;
}

/** The shape `realtime-js` wants for its `accessToken` option. */
export async function realtimeAccessToken(): Promise<string | null> {
  return (await getRealtimeToken())?.token ?? null;
}

/** Forget the cached token (sign-out, or a 401 telling us the session is gone). */
export function clearRealtimeToken(): void {
  cached = null;
}

async function load(): Promise<RealtimeToken | null> {
  try {
    const res = await fetch("/api/realtime/token", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) return cached; // 401 mid sign-out, 503 on a restart
    const body = (await res.json()) as RealtimeToken;
    if (!body?.token) return cached;
    cached = { token: body.token, expiresAt: body.expiresAt };
    return cached;
  } catch {
    return cached;
  }
}
