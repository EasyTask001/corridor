import { timingSafeEqual } from "node:crypto";

/**
 * Shared bearer-secret check for a route that must fail **closed** in every
 * direction:
 *  - the named env var is unset → 503. These routes run under the service
 *    role and touch every organization's data (or, for readiness, more
 *    operational detail than the public internet needs), so an unset secret
 *    is a deployment fault, never an invitation. It is deliberately not
 *    relaxed for non-production: two cron routes used to disagree about that
 *    (security review F1) and one of them was open to anyone who could reach
 *    it — there is no `NODE_ENV` branch here, and there must never be one.
 *  - wrong secret → 401, compared with `timingSafeEqual` after a length check
 *    (`timingSafeEqual` throws on differing lengths).
 *
 * Returns the response to send, or `null` when the caller is authorised.
 */
export function bearerSecretFailure(
  req: Request,
  envName: string,
  unconfiguredMessage: string,
): Response | null {
  const secret = process.env[envName];
  if (!secret) {
    return Response.json({ error: unconfiguredMessage }, { status: 503 });
  }
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (provided.length !== secret.length) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(secret))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/** `/api/jobs/process`, `/api/jobs/expiry-scan`. */
export const cronAuthFailure = (req: Request): Response | null =>
  bearerSecretFailure(req, "CRON_SECRET", "cron secret is not configured");

/**
 * `/api/ready`'s detailed view. Unlike `cronAuthFailure`, the caller never
 * sends this response on to the client — an unset or wrong secret just means
 * "fall back to the shallow `{ ok }` body", so the readiness route never
 * itself returns a 503/401 for this reason.
 */
export const readinessAuthFailure = (req: Request): Response | null =>
  bearerSecretFailure(req, "READINESS_SECRET", "readiness secret is not configured");
