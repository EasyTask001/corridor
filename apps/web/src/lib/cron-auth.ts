import { timingSafeEqual } from "node:crypto";

/**
 * Bearer-token check shared by the cron-triggered routes
 * (`/api/jobs/process`, `/api/jobs/expiry-scan`).
 *
 * Fails **closed** in every direction:
 *  - no `CRON_SECRET` configured → 503. These routes run under the service
 *    role and touch every organization's data, so an unset secret is a
 *    deployment fault, never an invitation. It is deliberately not relaxed for
 *    non-production: the two routes used to disagree about that (security
 *    review F1) and one of them was open to anyone who could reach it.
 *  - wrong secret → 401, compared with `timingSafeEqual` after a length check
 *    (`timingSafeEqual` throws on differing lengths).
 *
 * Returns the response to send, or `null` when the caller is authorised.
 */
export function cronAuthFailure(req: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "cron secret is not configured" }, { status: 503 });
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
