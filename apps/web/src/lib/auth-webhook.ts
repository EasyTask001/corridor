import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { verifyStandardWebhook } from "./standard-webhook";

/**
 * Payload and authentication for the `auth.users` **Database Webhook**.
 *
 * Supabase has no auth-lifecycle hook that reports created/updated/deleted
 * users: the Auth Hooks are `before_user_created`, `custom_access_token`,
 * `send_sms`, `send_email` and the MFA/password verification hooks, and
 * `before_user_created` is a *gate* — a non-2xx answer from it denies the
 * sign-up. The mechanism that actually delivers row lifecycle events is a
 * Database Webhook (a `supabase_functions.http_request` trigger) on
 * `auth.users`, which POSTs the row itself. Hence this shape.
 */

/** The `auth.users` columns this route needs. Everything else is ignored. */
export const authUserRecord = z
  .object({
    id: z.uuid(),
    email: z.string().nullish(),
    raw_user_meta_data: z.record(z.string(), z.unknown()).nullish(),
  })
  .loose();
export type AuthUserRecord = z.infer<typeof authUserRecord>;

/** What a Database Webhook POSTs. `record` is null on DELETE, `old_record` on INSERT. */
export const databaseWebhookPayload = z.object({
  type: z.enum(["INSERT", "UPDATE", "DELETE"]),
  table: z.string(),
  schema: z.string(),
  record: authUserRecord.nullish(),
  old_record: authUserRecord.nullish(),
});
export type DatabaseWebhookPayload = z.infer<typeof databaseWebhookPayload>;

/** Header carrying the shared secret; Database Webhooks let you set custom headers. */
export const WEBHOOK_SECRET_HEADER = "x-corridor-webhook-secret";

export type ParseResult =
  | { ok: true; payload: DatabaseWebhookPayload; record: AuthUserRecord }
  | { ok: false; reason: string };

/**
 * Parse the body and confirm it is an `auth.users` event carrying a row.
 * Anything else — another table, another schema, a DELETE with no `old_record`
 * — is a misconfigured trigger, so it is rejected rather than guessed at.
 */
export function parseAuthWebhook(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "body is not valid JSON" };
  }
  const parsed = databaseWebhookPayload.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "not a Database Webhook payload" };

  const payload = parsed.data;
  if (payload.schema !== "auth" || payload.table !== "users") {
    return { ok: false, reason: `unexpected source ${payload.schema}.${payload.table}` };
  }

  const record = payload.type === "DELETE" ? payload.old_record : payload.record;
  if (!record) return { ok: false, reason: `${payload.type} carried no row` };

  return { ok: true, payload, record };
}

/**
 * Mirrors `public.handle_new_auth_user` (migration 0001):
 * `coalesce(raw_user_meta_data ->> 'display_name', split_part(email, '@', 1))`.
 * Keeping the two in step means the trigger and the webhook never disagree
 * about a user's name.
 */
export function displayNameFor(record: AuthUserRecord): string | null {
  const fromMeta = record.raw_user_meta_data?.display_name;
  if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta.trim();
  const local = record.email?.split("@")[0]?.trim();
  return local || null;
}

export type AuthResult = { ok: true } | { ok: false; reason: string };

/**
 * A Database Webhook cannot sign its payload, so the shared secret it sends in
 * `x-corridor-webhook-secret` is the primary credential (compared in constant
 * time). Standard Webhooks headers are honoured *in addition* when present, so
 * a sender that can sign — a future Edge Function relay, say — is verified
 * properly rather than trusted on the header alone.
 */
export function authorizeAuthWebhook(opts: {
  secret: string;
  body: string;
  headers: Headers;
  now?: number;
}): AuthResult {
  const provided = opts.headers.get(WEBHOOK_SECRET_HEADER);
  if (!provided) return { ok: false, reason: `missing ${WEBHOOK_SECRET_HEADER}` };
  if (!secretsMatch(provided, opts.secret)) {
    return { ok: false, reason: "shared secret mismatch" };
  }

  const signed = opts.headers.get("webhook-signature");
  if (signed) {
    const verified = verifyStandardWebhook({
      secret: opts.secret,
      body: opts.body,
      headers: opts.headers,
      ...(opts.now !== undefined && { now: opts.now }),
    });
    if (!verified.ok) return { ok: false, reason: verified.reason };
  }

  return { ok: true };
}

/** Constant-time compare. Length is not secret, but it must not throw. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
