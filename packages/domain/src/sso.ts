import { z } from "zod";

/**
 * SAML single sign-on — the shapes shared by the router, the SSO wrapper and
 * the login page.
 *
 * Corridor stores the domain→organization mapping itself (`organization_sso`,
 * migration 0014) so the login page can hint "your company uses SSO" and so an
 * enterprise can *enforce* it. The authoritative domain→provider mapping for
 * the redirect itself lives in Supabase Auth: `signInWithSSO({ domain })`
 * resolves it there, and GoTrue — not this table — decides which IdP a domain
 * belongs to.
 */

/**
 * A DNS domain, lower-cased. Deliberately narrow: it is compared against the
 * part of an email address after the `@`, so no scheme, port, path, `@`, or
 * wildcard. At least one dot, so `localhost` or a bare TLD cannot claim every
 * address that happens to end in it.
 */
export const ssoDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    "Enter a domain such as acme.com",
  );

/**
 * The domain part of an email address, lower-cased, or `null` when the input is
 * not an address with a usable domain. Used by `GET /api/auth/sso` to decide
 * whether a lookup is worth doing, and by the login page to hand
 * `signInWithSSO({ domain })` the right value.
 */
export function emailDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const parsed = ssoDomain.safeParse(trimmed.slice(at + 1));
  return parsed.success ? parsed.data : null;
}

/** Metadata is supplied as a URL the IdP publishes, or as the XML itself. */
export const ssoConfigureInput = z
  .object({
    /** https only — GoTrue fetches this server-side. */
    metadataUrl: z
      .string()
      .trim()
      .url()
      .refine((u) => u.startsWith("https://"), "Metadata URL must use https")
      .optional(),
    metadataXml: z.string().trim().min(1).max(500_000).optional(),
    domains: z.array(ssoDomain).min(1).max(20),
    /** Hide password sign-in for these domains once the IdP is live. */
    enforced: z.boolean().default(false),
  })
  .refine(
    (v) => Boolean(v.metadataUrl) !== Boolean(v.metadataXml),
    "Provide either a metadata URL or metadata XML, not both",
  )
  .refine(
    (v) => new Set(v.domains).size === v.domains.length,
    "The same domain is listed more than once",
  );
export type SsoConfigureInput = z.infer<typeof ssoConfigureInput>;

/** What the login page is told about an email address, and nothing else. */
export const ssoLookupResult = z.object({
  /** An SSO provider claims this address's domain. */
  sso: z.boolean(),
  /** …and password sign-in is turned off for it. */
  enforced: z.boolean(),
});
export type SsoLookupResult = z.infer<typeof ssoLookupResult>;
