import { createClient } from "@supabase/supabase-js";
import { emailDomain } from "@corridor/domain";
import { env } from "@/lib/env";

/**
 * Server-side SSO lookups for an email address, over the two SECURITY DEFINER
 * resolvers from migration 0014. They are granted to `anon`, so the anon key is
 * enough: neither reads a table the caller could not already reach, and both
 * return a single scalar.
 */

export interface SsoLookup {
  /** An SSO provider claims this address's domain. */
  sso: boolean;
  /** …and password sign-in is refused for it. */
  enforced: boolean;
}

export const NO_SSO: SsoLookup = { sso: false, enforced: false };

/** Shown when someone on an enforced domain tries to sign in with a password. */
export const SSO_REQUIRED_MESSAGE =
  "This organization requires single sign-on. Use Continue with SSO.";

/**
 * Shown when the enforcement check itself failed. Deliberately a refusal:
 * `passwordSignInBlockedFor` is the *control*, not the hint, so it fails closed
 * — an outage of the resolver must not quietly re-open password sign-in for a
 * domain that switched it off.
 */
export const SSO_CHECK_FAILED_MESSAGE =
  "Could not verify how this organization signs in. Try again in a moment.";

/**
 * Ask the resolvers about one address. Throws if either RPC fails — each caller
 * decides whether that means "offer the password form" (the login-page hint) or
 * "refuse" (the sign-in guard).
 */
export async function lookupSso(email: string): Promise<SsoLookup> {
  if (!emailDomain(email)) return NO_SSO;

  const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const api = supabase.schema("api");
  let [provider, enforced] = await Promise.all([
    api.rpc("sso_provider_for_email", { p_email: email }),
    api.rpc("sso_enforced_for_email", { p_email: email }),
  ]);

  // Some hosted projects expose only Supabase's default public schema. The
  // same tightly granted SECURITY DEFINER resolvers live there, so use them
  // only when PostgREST explicitly says the hardened api schema is unavailable.
  if (provider.error && provider.error.code !== "PGRST106") {
    throw new Error(provider.error.message);
  }
  if (enforced.error && enforced.error.code !== "PGRST106") {
    throw new Error(enforced.error.message);
  }
  if (provider.error || enforced.error) {
    [provider, enforced] = await Promise.all([
      supabase.rpc("sso_provider_for_email", { p_email: email }),
      supabase.rpc("sso_enforced_for_email", { p_email: email }),
    ]);
  }
  if (provider.error) throw new Error(provider.error.message);
  if (enforced.error) throw new Error(enforced.error.message);

  const sso = typeof provider.data === "string" && provider.data.length > 0;
  return { sso, enforced: sso && enforced.data === true };
}

/**
 * The server-side half of "Require SSO": the reason to refuse a password
 * sign-in or sign-up for this address, or `null` when it may proceed.
 *
 * The login form hides the password field for an enforced domain, but that is
 * decoration — a scripted POST, or a rate-limited lookup that left the field on
 * screen, would otherwise walk straight past it. Every password entry point
 * calls this first.
 */
export async function passwordSignInBlockedFor(email: string): Promise<string | null> {
  // Not an address whose domain we could map: Auth will reject it on its own,
  // and there is no configuration that could possibly claim it.
  if (!emailDomain(email)) return null;
  try {
    const { enforced } = await lookupSso(email);
    return enforced ? SSO_REQUIRED_MESSAGE : null;
  } catch (error) {
    console.error("[sso] enforcement check failed; refusing password sign-in", error);
    return SSO_CHECK_FAILED_MESSAGE;
  }
}
