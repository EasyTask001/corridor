import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { PermissionKey } from "@corridor/domain";

export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string | null;
}

export interface OrgMembership {
  organizationId: string;
  organizationName: string;
  roleId: string;
  roleName: string;
  status: "invited" | "active" | "suspended";
}

/** Fully-resolved caller identity used by tRPC context and Server Components. */
export interface Session {
  user: SessionUser;
  memberships: OrgMembership[];
  /** The org the caller is acting in for this request (header/cookie/default). */
  activeOrganizationId: string | null;
  permissions: ReadonlySet<PermissionKey>;
  /** Raw JWT — needed to set `request.jwt.claims` for RLS. Never sent to the browser. */
  accessToken: string;
}

export function toSessionUser(u: User, displayName?: string | null): SessionUser {
  return {
    id: u.id,
    email: u.email ?? null,
    displayName:
      displayName ??
      (typeof u.user_metadata?.display_name === "string" ? u.user_metadata.display_name : null),
  };
}

/**
 * Resolve a Supabase user from either an SSR cookie session (web) or an
 * `Authorization: Bearer <jwt>` header (future Expo app). Both terminate in
 * `supabase.auth.getUser()`, which validates the token server-side.
 */
export async function resolveUser(
  supabase: SupabaseClient,
  bearerToken?: string | null,
): Promise<{ user: User; accessToken: string } | null> {
  if (bearerToken) {
    const { data, error } = await supabase.auth.getUser(bearerToken);
    if (error || !data.user) return null;
    return { user: data.user, accessToken: bearerToken };
  }
  const [{ data: userData, error }, { data: sessionData }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.getSession(),
  ]);
  if (error || !userData.user || !sessionData.session) return null;
  return { user: userData.user, accessToken: sessionData.session.access_token };
}

export function extractBearer(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m?.[1] ?? null;
}
