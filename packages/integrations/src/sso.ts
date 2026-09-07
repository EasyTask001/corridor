/**
 * SAML single sign-on — a thin wrapper over Supabase Auth's SSO admin API.
 *
 * Corridor never sees a SAML assertion: GoTrue owns the providers, the
 * domain→provider mapping and the ACS endpoint. All this module does is
 * register / re-register / remove the provider that an enterprise tenant
 * configures from Settings → Organization, so that
 * `supabase.auth.signInWithSSO({ domain })` in the browser has something to
 * resolve.
 *
 * Why raw `fetch` and not `supabase.auth.admin.createSSOProvider`: the pinned
 * @supabase/auth-js (2.115.0) ships no SSO methods on `GoTrueAdminApi` — only
 * the client-side `signInWithSSO`. The REST endpoints
 * (`/auth/v1/admin/sso/providers`) are the same ones that helper would call,
 * and they are stable; when auth-js grows the methods this file is the only
 * place to change.
 *
 * **Mock mode.** Two situations produce a synthetic provider whose id is
 * prefixed `mock-sso-`, so the rest of the product (the settings UI, the audit
 * trail, the enforcement flag, the login-page hint) is exercisable without a
 * SAML-capable Auth instance:
 *
 *   1. no Supabase URL / service-role key configured, and
 *   2. the instance answering that SAML is disabled.
 *
 * A mock id never reaches the network again: updating one re-issues the echo,
 * deleting one is a no-op. `isMockProviderId()` is what the UI badges and what
 * keeps a mock configuration from being mistaken for a live IdP.
 */
import { randomUUID } from "node:crypto";

export type SsoMode = "saml" | "mock";

/** Prefix of every synthetic provider id. Never a value GoTrue would issue. */
export const MOCK_SSO_PROVIDER_PREFIX = "mock-sso-";

export function isMockProviderId(providerId: string): boolean {
  return providerId.startsWith(MOCK_SSO_PROVIDER_PREFIX);
}

export interface SsoEnv {
  /** Base URL of the Supabase instance, e.g. `https://xyz.supabase.co`. */
  url?: string;
  serviceRoleKey?: string;
  /** Injection point for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export function readSsoEnv(env: NodeJS.ProcessEnv = process.env): SsoEnv {
  return {
    url: env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/** `"saml"` when a service-role-capable Auth instance is configured. */
export function ssoMode(env: SsoEnv = readSsoEnv()): SsoMode {
  return env.url && env.serviceRoleKey ? "saml" : "mock";
}

/** What the caller supplies: the IdP's metadata, plus the domains it claims. */
export interface SsoProviderInput {
  /** Exactly one of these two is set (enforced by `ssoConfigureInput`). */
  metadataUrl?: string;
  metadataXml?: string;
  domains: string[];
}

export interface SsoProvider {
  /** GoTrue's provider uuid, or a `mock-sso-…` id. */
  id: string;
  domains: string[];
  /** SAML EntityID as GoTrue parsed it out of the metadata; null in mock mode. */
  entityId: string | null;
  mode: SsoMode;
}

interface GoTrueErrorBody {
  code?: number;
  error_code?: string;
  msg?: string;
  error?: string;
  error_description?: string;
  message?: string;
}

interface GoTrueProviderBody {
  id: string;
  saml?: { entity_id?: string | null } | null;
  domains?: { domain: string }[] | null;
}

/**
 * True when the instance is telling us SAML is switched off (GoTrue's
 * `GOTRUE_SAML_ENABLED` / missing SAML private key) rather than rejecting this
 * particular request. Matched on the wording rather than the status code
 * because GoTrue has reported it as 404, 500 and 501 across versions — but only
 * ever with "SAML" and "disabled"/"not enabled" in the message.
 */
export function reportsSamlDisabled(body: unknown): boolean {
  const e = (body ?? {}) as GoTrueErrorBody;
  const text = [e.error_code, e.msg, e.error, e.error_description, e.message]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!text.includes("saml")) return false;
  return (
    text.includes("disabled") || text.includes("not enabled") || text.includes("not supported")
  );
}

function mockProvider(input: SsoProviderInput, id?: string): SsoProvider {
  return {
    id: id ?? `${MOCK_SSO_PROVIDER_PREFIX}${randomUUID()}`,
    domains: [...input.domains],
    entityId: null,
    mode: "mock",
  };
}

function toProvider(body: GoTrueProviderBody, input: SsoProviderInput): SsoProvider {
  return {
    id: body.id,
    domains: body.domains?.map((d) => d.domain) ?? [...input.domains],
    entityId: body.saml?.entity_id ?? null,
    mode: "saml",
  };
}

function requestBody(input: SsoProviderInput): Record<string, unknown> {
  return {
    type: "saml",
    ...(input.metadataUrl ? { metadata_url: input.metadataUrl } : {}),
    ...(input.metadataXml ? { metadata_xml: input.metadataXml } : {}),
    domains: input.domains,
  };
}

/** Raised when GoTrue rejects the request for a reason the operator can fix. */
export class SsoProviderError extends Error {
  override readonly name = "SsoProviderError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface AdminCall {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  env: SsoEnv;
}

/**
 * One call to `/auth/v1/admin/sso/providers…`.
 *
 * Returns `null` — meaning "fall back to mock" — when SAML is disabled on the
 * instance. Any other failure throws, because an operator who typed a bad
 * metadata URL must see that rather than a silent mock provider.
 */
async function callAdmin({ method, path, body, env }: AdminCall): Promise<unknown | null> {
  const doFetch = env.fetchImpl ?? globalThis.fetch;
  const key = env.serviceRoleKey!;
  const response = await doFetch(
    `${env.url!.replace(/\/$/, "")}/auth/v1/admin/sso/providers${path}`,
    {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (response.ok) return parsed;
  if (reportsSamlDisabled(parsed)) return null;

  const e = (parsed ?? {}) as GoTrueErrorBody;
  const message = e.msg ?? e.error_description ?? e.message ?? e.error ?? text.slice(0, 200);
  throw new SsoProviderError(response.status, message || "SSO API error");
}

/** Register a new SAML provider. Falls back to a `mock-sso-…` id (see above). */
export async function createSsoProvider(
  input: SsoProviderInput,
  env: SsoEnv = readSsoEnv(),
): Promise<SsoProvider> {
  if (ssoMode(env) === "mock") return mockProvider(input);
  const body = await callAdmin({ method: "POST", path: "", body: requestBody(input), env });
  if (!body) return mockProvider(input);
  return toProvider(body as GoTrueProviderBody, input);
}

/**
 * Re-register an existing provider with new metadata / domains.
 *
 * A mock id is echoed back unchanged: there is nothing on the other side to
 * update, and calling GoTrue with it would 404.
 */
export async function updateSsoProvider(
  providerId: string,
  input: SsoProviderInput,
  env: SsoEnv = readSsoEnv(),
): Promise<SsoProvider> {
  if (isMockProviderId(providerId) || ssoMode(env) === "mock") {
    return mockProvider(input, providerId);
  }
  const body = await callAdmin({
    method: "PUT",
    path: `/${encodeURIComponent(providerId)}`,
    body: requestBody(input),
    env,
  });
  if (!body) return mockProvider(input, providerId);
  return toProvider(body as GoTrueProviderBody, input);
}

/**
 * Remove a provider. Idempotent: a provider GoTrue no longer has (404) counts
 * as removed, so a half-finished `remove` can always be retried.
 */
export async function deleteSsoProvider(
  providerId: string,
  env: SsoEnv = readSsoEnv(),
): Promise<{ mode: SsoMode }> {
  if (isMockProviderId(providerId) || ssoMode(env) === "mock") return { mode: "mock" };
  try {
    const body = await callAdmin({
      method: "DELETE",
      path: `/${encodeURIComponent(providerId)}`,
      env,
    });
    return { mode: body ? "saml" : "mock" };
  } catch (error) {
    if (error instanceof SsoProviderError && error.status === 404) return { mode: "saml" };
    throw error;
  }
}
