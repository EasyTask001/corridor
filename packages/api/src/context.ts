import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PermissionKey } from "@corridor/domain";
import {
  extractBearer,
  resolveUser,
  toSessionUser,
  type OrgMembership,
  type Session,
} from "@corridor/auth";
import { getDb, withRls, type DatabaseClient, type RlsTransaction } from "@corridor/db";

export const ACTIVE_ORG_HEADER = "x-corridor-org";
export const ACTIVE_ORG_COOKIE = "corridor_org";

export interface CreateContextOptions {
  /** Request headers — used for `Authorization: Bearer` (mobile) and the active-org hint. */
  headers: Headers;
  /**
   * A Supabase client bound to the caller. On the web this is the
   * `@supabase/ssr` server client (cookie session); for Bearer callers any
   * anon-key client works because `getUser(token)` validates the token itself.
   */
  supabase: SupabaseClient;
  /** Active org hint from a cookie (web). Header wins over cookie. */
  activeOrgCookie?: string | null;
  db?: DatabaseClient;
}

export interface Context {
  session: Session | null;
  supabase: SupabaseClient;
  db: DatabaseClient;
  /** Run a Drizzle transaction under the caller's RLS claims. Throws if unauthenticated. */
  rls: <T>(fn: (tx: RlsTransaction) => Promise<T>) => Promise<T>;
}

interface MembershipRow {
  organization_id: string;
  role_id: string;
  status: OrgMembership["status"];
  organizations: { name: string } | null;
  roles: { name: string } | null;
}

/**
 * Resolves the caller from either a cookie session (web) or a Bearer token
 * (future Expo app) — both terminate in `supabase.auth.getUser()`.
 */
export async function createContext(opts: CreateContextOptions): Promise<Context> {
  const db = opts.db ?? getDb();
  const bearer = extractBearer(opts.headers.get("authorization"));
  const resolved = await resolveUser(opts.supabase, bearer);

  if (!resolved) {
    return {
      session: null,
      supabase: opts.supabase,
      db,
      rls: async () => {
        throw new Error("UNAUTHORIZED");
      },
    };
  }

  const { user, accessToken } = resolved;

  // Memberships are read through supabase-js so RLS applies with the caller's
  // own JWT (the client is session-bound for cookies; for Bearer we pass it).
  const authed = bearer ? withBearer(opts.supabase, accessToken) : opts.supabase;

  const [{ data: memberRows }, { data: profile }] = await Promise.all([
    authed
      .from("organization_members")
      .select("organization_id, role_id, status, organizations(name), roles(name)")
      .eq("user_id", user.id)
      .returns<MembershipRow[]>(),
    authed.from("user_profiles").select("display_name").eq("user_id", user.id).maybeSingle(),
  ]);

  const memberships: OrgMembership[] = (memberRows ?? []).map((m) => ({
    organizationId: m.organization_id,
    organizationName: m.organizations?.name ?? "",
    roleId: m.role_id,
    roleName: m.roles?.name ?? "",
    status: m.status,
  }));

  const active = memberships.filter((m) => m.status === "active");
  const hint = opts.headers.get(ACTIVE_ORG_HEADER) ?? opts.activeOrgCookie ?? null;
  const activeOrganizationId =
    (hint && active.find((m) => m.organizationId === hint)?.organizationId) ??
    active[0]?.organizationId ??
    null;

  let permissions = new Set<PermissionKey>();
  if (activeOrganizationId) {
    const { data } = await authed.rpc("current_user_permissions", {
      org_id: activeOrganizationId,
    });
    permissions = new Set((data ?? []) as PermissionKey[]);
  }

  const session: Session = {
    user: toSessionUser(user, (profile as { display_name?: string | null } | null)?.display_name),
    memberships,
    activeOrganizationId,
    permissions,
    accessToken,
  };

  return {
    session,
    supabase: authed,
    db,
    rls: (fn) => withRls(db, { sub: user.id, email: user.email ?? undefined }, fn),
  };
}

/**
 * Return a client whose PostgREST calls carry the Bearer token (mobile path).
 * Rebuilt from the same URL/anon key with a global Authorization header.
 */
function withBearer(client: SupabaseClient, token: string): SupabaseClient {
  const { supabaseUrl, supabaseKey } = client as unknown as {
    supabaseUrl: string;
    supabaseKey: string;
  };
  return createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
