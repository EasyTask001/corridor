import { rateLimitFor } from "@corridor/api";
import { lookupSso, NO_SSO, type SsoLookup } from "@/lib/sso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Does this email address sign in with SSO?" — the one question the login page
 * has to ask before anybody is authenticated.
 *
 * What it deliberately does NOT return: the provider id, the organization id,
 * the organization name, the domain list. Two booleans, and nothing that turns
 * a guessed address into information about a customer. The redirect itself does
 * not need the provider either — `signInWithSSO({ domain })` resolves the
 * domain against Supabase Auth, which is the authoritative mapping.
 *
 * This is a **hint**, not the enforcement: it fails open, because a resolver
 * outage must not take the login page down with it. The control that actually
 * refuses a password on an enforced domain is `passwordSignInBlockedFor()` in
 * the sign-in server action, which fails closed.
 *
 * Because it is public it is counted by IP (`sso:ip:<ip>`) against the trial
 * ceiling of the `standard` tier — the tRPC procedures' per-user counter has
 * nothing to key on here. A caller enumerating domains hits that within a
 * minute; a person typing their address once does not.
 */
export async function GET(req: Request) {
  const email = new URL(req.url).searchParams.get("email") ?? "";

  const limit = await rateLimitFor("standard", "trial").check({
    orgId: null,
    userId: "anonymous",
    key: `sso:ip:${clientIp(req)}`,
  });
  if (!limit.success) {
    return Response.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(limit.retryAfterSeconds),
        },
      },
    );
  }

  try {
    return answer(await lookupSso(email));
  } catch (error) {
    console.error("[sso] lookup failed", error);
    return answer(NO_SSO);
  }
}

function answer(result: SsoLookup) {
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}

/** First hop in `x-forwarded-for` (what Vercel sets), else the direct peer. */
function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip") || "unknown";
}
