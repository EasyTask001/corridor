import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Standard Webhooks (https://www.standardwebhooks.com) signature verification —
 * the scheme Supabase Auth hooks use.
 *
 * Implemented here with `node:crypto` rather than pulling in the
 * `standardwebhooks` package: it is a dozen lines, and a dependency that can
 * verify signatures is a dependency that can forge them.
 *
 *   signed content = `${webhook-id}.${webhook-timestamp}.${raw body}`
 *   signature      = base64(HMAC-SHA256(secret, content))
 *   header         = space-separated `v1,<signature>` entries (key rotation)
 *
 * The secret is base64, optionally prefixed `whsec_`.
 */

/** Reject anything signed more than this long ago (replay window). */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface VerifyOptions {
  /** The `SUPABASE_AUTH_WEBHOOK_SECRET` value, with or without the `whsec_` prefix. */
  secret: string;
  /** The raw request body — the exact bytes that were signed, never a re-serialised object. */
  body: string;
  /** The request headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`). */
  headers: Headers;
  /** Injectable clock for tests. */
  now?: number;
}

export function verifyStandardWebhook({
  secret,
  body,
  headers,
  now = Date.now(),
}: VerifyOptions): VerifyResult {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatureHeader = headers.get("webhook-signature");
  if (!id || !timestamp || !signatureHeader) return fail("missing webhook headers");

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return fail("malformed webhook-timestamp");
  if (Math.abs(now - seconds * 1000) > WEBHOOK_TOLERANCE_MS) {
    return fail("webhook-timestamp outside the tolerance window");
  }

  let key: Buffer;
  try {
    key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  } catch {
    return fail("secret is not valid base64");
  }
  if (key.length === 0) return fail("secret is empty");

  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();

  // The header may carry several versioned signatures during a key rotation;
  // any `v1` entry matching is enough.
  const candidates = signatureHeader
    .split(" ")
    .filter((part) => part.startsWith("v1,"))
    .map((part) => part.slice(3));
  if (candidates.length === 0) return fail("no v1 signature in webhook-signature");

  for (const candidate of candidates) {
    let provided: Buffer;
    try {
      provided = Buffer.from(candidate, "base64");
    } catch {
      continue;
    }
    // Length is not secret; timingSafeEqual requires equal lengths.
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return { ok: true };
    }
  }
  return fail("signature mismatch");
}

function fail(reason: string): VerifyResult {
  return { ok: false, reason };
}

/** Sign a payload the way a sender would. Used by the tests; handy for local curls. */
export function signStandardWebhook(opts: {
  secret: string;
  body: string;
  id: string;
  timestamp: number;
}): string {
  const key = Buffer.from(opts.secret.replace(/^whsec_/, ""), "base64");
  const mac = createHmac("sha256", key)
    .update(`${opts.id}.${opts.timestamp}.${opts.body}`)
    .digest("base64");
  return `v1,${mac}`;
}
