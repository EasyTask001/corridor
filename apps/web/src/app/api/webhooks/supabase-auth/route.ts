import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { verifyStandardWebhook } from "@/lib/standard-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Supabase Auth → Corridor.
 *
 * `public.handle_new_auth_user` (migration 0001) already mirrors a new sign-up
 * into `user_profiles` from inside the database, which is the path that must
 * never fail. This webhook is the out-of-database complement: it keeps the
 * profile in step with later Auth-side changes (a display-name edit, a delete)
 * that no trigger covers, and it is written to be safe to replay — every write
 * is an idempotent upsert keyed on `user_id`.
 *
 * Degradation: with no `SUPABASE_AUTH_WEBHOOK_SECRET` configured the route
 * answers 503 and logs. It never processes an unsigned payload — an unsigned
 * caller could otherwise rename any user's profile.
 */

const authUser = z.object({
  id: z.uuid(),
  email: z.string().nullish(),
  // Supabase sends `user_metadata` on hook payloads and `raw_user_meta_data`
  // on database-webhook style rows; accept either.
  user_metadata: z.record(z.string(), z.unknown()).nullish(),
  raw_user_meta_data: z.record(z.string(), z.unknown()).nullish(),
});

const payloadSchema = z.object({
  type: z.string(),
  user: authUser.nullish(),
  record: authUser.nullish(),
});

export async function POST(req: Request) {
  const secret = process.env.SUPABASE_AUTH_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[auth-webhook] SUPABASE_AUTH_WEBHOOK_SECRET is not set — payload ignored");
    return Response.json({ error: "auth webhook not configured" }, { status: 503 });
  }

  const raw = await req.text();
  const verified = verifyStandardWebhook({ secret, body: raw, headers: req.headers });
  if (!verified.ok) {
    console.warn(`[auth-webhook] rejected: ${verified.reason}`);
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  let parsed;
  try {
    parsed = payloadSchema.safeParse(JSON.parse(raw));
  } catch {
    return Response.json({ error: "malformed payload" }, { status: 400 });
  }
  if (!parsed.success) return Response.json({ error: "malformed payload" }, { status: 400 });

  const { type } = parsed.data;
  const user = parsed.data.user ?? parsed.data.record;
  if (!user) return Response.json({ error: "payload has no user" }, { status: 400 });

  const supabase = serviceRoleClient();
  if (!supabase) {
    console.error("[auth-webhook] service-role client unavailable — cannot sync user_profiles");
    return Response.json({ error: "service role not configured" }, { status: 503 });
  }

  switch (type) {
    case "user.created": {
      // `ignoreDuplicates` so a replay — or the trigger having already run,
      // which is the normal case — never overwrites a name the user has since
      // changed in the app.
      const { error } = await supabase
        .from("user_profiles")
        .upsert(
          { user_id: user.id, display_name: displayName(user) },
          { onConflict: "user_id", ignoreDuplicates: true },
        );
      if (error) return failed("user.created", error.message);
      break;
    }
    case "user.updated": {
      // Auth is the source of truth for the name here, so this one does write
      // over an existing row.
      const { error } = await supabase
        .from("user_profiles")
        .upsert(
          { user_id: user.id, display_name: displayName(user) },
          { onConflict: "user_id", ignoreDuplicates: false },
        );
      if (error) return failed("user.updated", error.message);
      break;
    }
    case "user.deleted":
      // `user_profiles.user_id` is `references auth.users(id) on delete
      // cascade`, so the row is already gone. Logged for the audit trail.
      console.info(`[auth-webhook] user.deleted ${user.id} — profile removed by cascade`);
      break;
    default:
      console.info(`[auth-webhook] ignoring unhandled event ${type}`);
      break;
  }

  return Response.json({ received: true });
}

/** `display_name` from metadata, else the local part of the email, else null. */
function displayName(user: z.infer<typeof authUser>): string | null {
  const meta = user.user_metadata ?? user.raw_user_meta_data ?? {};
  const fromMeta = meta.display_name ?? meta.full_name ?? meta.name;
  if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta.trim();
  const local = user.email?.split("@")[0]?.trim();
  return local || null;
}

/**
 * Service role: this runs with no session at all (Supabase Auth is the caller),
 * and `user_profiles` RLS only lets a user write their own row.
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
