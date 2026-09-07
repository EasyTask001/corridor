"use client";

import { createBrowserClient } from "@supabase/ssr";
import { realtimeAccessToken } from "./realtime-token";

let client: ReturnType<typeof createBrowserClient> | undefined;

/**
 * Browser client — Storage uploads (signed-URL, so no session needed) and
 * Realtime.
 *
 * It has **no session of its own**: the auth cookies are httpOnly, so this
 * client cannot read them and, left alone, its socket authenticates as `anon` —
 * whereupon RLS (`to authenticated`) silently drops every row a subscription
 * would have delivered.
 *
 * The fix is the `realtime.accessToken` callback below. `supabase-js` installs
 * its own callback (which reads the session it does not have) and re-runs it on
 * every connect and heartbeat, so a bare `realtime.setAuth(token)` would be
 * overwritten within a heartbeat; because the options spread lands after that
 * default, ours wins and every reconnect re-reads the cached token from
 * `/api/realtime/token`. `supabase.auth` is untouched — only the socket's token
 * source changes.
 *
 * Components should still subscribe through `useRealtimeClient()`, which waits
 * for the first token before handing the client over.
 */
export function createSupabaseBrowserClient() {
  client ??= createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { realtime: { accessToken: realtimeAccessToken } },
  );
  return client;
}
