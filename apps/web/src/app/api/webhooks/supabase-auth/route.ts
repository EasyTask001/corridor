import { createClient } from "@supabase/supabase-js";
import { authorizeAuthWebhook, displayNameFor, parseAuthWebhook } from "@/lib/auth-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `auth.users` Database Webhook → Corridor.
 *
 * `public.handle_new_auth_user` (migration 0001) already mirrors a new sign-up
 * into `user_profiles` from inside the database, which is the path that must
 * never fail. This route is the out-of-database complement: it keeps the
 * profile in step with later Auth-side changes (a display-name edit, a delete)
 * that no trigger covers, and it is safe to replay — every write is an
 * idempotent upsert keyed on `user_id`.
 *
 * It is wired as a **Database Webhook on `auth.users`** (see the comment block
 * in `supabase/config.toml`), not as an Auth Hook: Supabase's Auth Hooks are
 * `before_user_created`, `custom_access_token`, `send_sms`, `send_email` and
 * the MFA/password ones, none of which report a created/updated/deleted user —
 * and `before_user_created` is a gate whose non-2xx response *denies* the
 * sign-up, so pointing it here would break registration.
 *
 * Degradation: with no `SUPABASE_AUTH_WEBHOOK_SECRET` configured the route
 * answers 503 and logs, and it never processes an unauthenticated payload — an
 * anonymous caller could otherwise rename any user's profile.
 */
export async function POST(req: Request) {
  const secret = process.env.SUPABASE_AUTH_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[auth-webhook] SUPABASE_AUTH_WEBHOOK_SECRET is not set — payload ignored");
    return Response.json({ error: "auth webhook not configured" }, { status: 503 });
  }

  const raw = await req.text();
  const authorized = authorizeAuthWebhook({ secret, body: raw, headers: req.headers });
  if (!authorized.ok) {
    console.warn(`[auth-webhook] rejected: ${authorized.reason}`);
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = parseAuthWebhook(raw);
  if (!parsed.ok) {
    console.warn(`[auth-webhook] bad payload: ${parsed.reason}`);
    return Response.json({ error: parsed.reason }, { status: 400 });
  }
  const { payload, record } = parsed;

  const supabase = serviceRoleClient();
  if (!supabase) {
    console.error("[auth-webhook] service-role client unavailable — cannot sync user_profiles");
    return Response.json({ error: "service role not configured" }, { status: 503 });
  }

  switch (payload.type) {
    case "INSERT": {
      // `ignoreDuplicates` so a replay — or the trigger having already run,
      // which is the normal case — never overwrites a name the user has since
      // changed in the app.
      const { error } = await supabase
        .from("user_profiles")
        .upsert(
          { user_id: record.id, display_name: displayNameFor(record) },
          { onConflict: "user_id", ignoreDuplicates: true },
        );
      if (error) return failed("INSERT", error.message);
      break;
    }
    case "UPDATE": {
      // Auth is the source of truth for the name here, so this one does write
      // over an existing row.
      const { error } = await supabase
        .from("user_profiles")
        .upsert(
          { user_id: record.id, display_name: displayNameFor(record) },
          { onConflict: "user_id", ignoreDuplicates: false },
        );
      if (error) return failed("UPDATE", error.message);
      break;
    }
    case "DELETE":
      // `user_profiles.user_id` is `references auth.users(id) on delete
      // cascade`, so the row is already gone. Logged for the audit trail.
      console.info(`[auth-webhook] DELETE ${record.id} — profile removed by cascade`);
      break;
  }

  return Response.json({ received: true });
}

/**
 * Service role: this runs with no session at all (Postgres is the caller), and
 * `user_profiles` RLS only lets a user write their own row.
 */
function serviceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function failed(event: string, message: string) {
  // 500 so the sender retries — the payload was authentic, the write was not.
  console.error(`[auth-webhook] ${event} failed: ${message}`);
  return Response.json({ error: "profile sync failed" }, { status: 500 });
}
