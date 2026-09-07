import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hands the browser a Realtime credential — and nothing else.
 *
 * Why this is safe, given that the session cookies are deliberately httpOnly:
 *
 *   1. Only the **access token** leaves the server. The refresh token stays in
 *      the httpOnly cookie, so a token stolen from the page dies with the JWT
 *      (`auth.jwt_expiry`, 1h by default) and cannot be traded for a new
 *      session. That is the whole reason the cookies are httpOnly.
 *   2. The token is exactly the one the caller already holds as a cookie. This
 *      route mints nothing and escalates nothing: it is a read of the caller's
 *      own session, gated on `getUser()` (which validates the JWT against Auth,
 *      unlike `getSession()`), returning 401 when there is no session.
 *   3. Same-origin only. The session cookies are `sameSite=lax`, so a
 *      cross-site `fetch` never carries them and this route answers 401; the
 *      explicit `Origin` check below makes that refusal loud rather than
 *      incidental, and no CORS headers are set so a cross-origin reader could
 *      not see the body anyway.
 *   4. `no-store`, so neither the browser nor a CDN retains the JWT.
 *
 * The token is used for one thing: `supabase.realtime.setAuth(token)` in
 * `lib/supabase/use-realtime-client.ts`. Without it the browser client
 * subscribes as `anon` and every RLS policy (`to authenticated`) silently drops
 * the rows — which is what made the three subscription sites dead weight.
 */
export async function GET(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) {
    return Response.json({ error: "cross-origin" }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  // getUser() first: it validates the JWT with Auth. getSession() alone only
  // decodes whatever the cookie says.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return unauthorized();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return unauthorized();

  // `expires_at` is unix seconds; the client refreshes 60s before this.
  const expiresAt = session.expires_at
    ? session.expires_at * 1000
    : Date.now() + (session.expires_in ?? 3600) * 1000;

  return Response.json(
    { token: session.access_token, expiresAt },
    { headers: { "cache-control": "no-store" } },
  );
}

function unauthorized() {
  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}
