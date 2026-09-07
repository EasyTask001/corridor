import { createClient } from "@supabase/supabase-js";
import { emailDomain } from "@corridor/domain";
import { rateLimitFor } from "@corridor/api";
import { env } from "@/lib/env";

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
 * Because it is public it is counted by IP (`sso:ip:<ip>`) against the trial
 * ceiling of the `standard` tier — the tRPC procedures' per-user counter has
 * nothing to key on here. A caller enumerating domains hits that within a
 * minute; a person typing their address once does not.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const email = url.searchParams.get("email") ?? "";
  const domain = emailDomain(email);

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

  // Not an address we could look up: answer the same shape rather than an
  // error, so the login page has one code path.
  if (!domain) return answer(false, false);

  const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Two SECURITY DEFINER resolvers, granted to `anon` (migration 0014). The
  // anon key is all this needs: it reads no table.
  const [provider, enforced] = await Promise.all([
    supabase.rpc("sso_provider_for_email", { p_email: email }),
    supabase.rpc("sso_enforced_for_email", { p_email: email }),
  ]);

  if (provider.error) {
    console.error("[sso] provider lookup failed", provider.error);
    // Degrade to password sign-in rather than locking everyone out.
    return answer(false, false);
  }

  const hasSso = typeof provider.data === "string" && provider.data.length > 0;
  return answer(hasSso, hasSso && enforced.data === true);
}

function answer(sso: boolean, enforced: boolean) {
  return Response.json({ sso, enforced }, { headers: { "cache-control": "no-store" } });
}

/** First hop in `x-forwarded-for` (what Vercel sets), else the direct peer. */
function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip") || "unknown";
}
