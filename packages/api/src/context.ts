import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PermissionKey, SubscriptionPlan } from "@corridor/domain";
import {
  extractBearer,
  resolveUser,
  toSessionUser,
  type OrgMembership,
  type Session,
} from "@corridor/auth";
import {
  asc,
  eq,
  getDb,
  schema,
  withRls,
  type DatabaseClient,
  type RlsTransaction,
} from "@corridor/db";
import { cachePermissions, getCachedPermissions } from "./infra/permission-cache";

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
  /** The request headers, for the few sessionless procedures that count by address (0027). */
  headers: Headers;
  /** Run a Drizzle transaction under the caller's RLS claims. Throws if unauthenticated. */
  rls: <T>(fn: (tx: RlsTransaction) => Promise<T>) => Promise<T>;
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
      headers: opts.headers,
      rls: () => {
        throw new Error("UNAUTHORIZED");
      },
    };
  }

  const { user, accessToken } = resolved;

  const authed = bearer ? withBearer(opts.supabase, accessToken) : opts.supabase;

  // `public` is intentionally not exposed through PostgREST. Bootstrap the
  // session through the same direct, caller-scoped RLS transaction as routers.
  const { organizationMembers, organizations, roles, userProfiles } = schema;
  const { rows, profile } = await withRls(
    db,
    { sub: user.id, email: user.email ?? undefined },
    async (tx) => {
      const memberships = await tx
        .select({
          organizationId: organizationMembers.organizationId,
          organizationName: organizations.name,
          roleId: organizationMembers.roleId,
          roleName: roles.name,
          status: organizationMembers.status,
          subscriptionPlan: organizations.subscriptionPlan,
        })
        .from(organizationMembers)
        .leftJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .leftJoin(roles, eq(roles.id, organizationMembers.roleId))
        .where(eq(organizationMembers.userId, user.id))
        .orderBy(asc(organizationMembers.createdAt));
      const [profile] = await tx
        .select({ displayName: userProfiles.displayName })
        .from(userProfiles)
        .where(eq(userProfiles.userId, user.id))
        .limit(1);
      return { rows: memberships, profile };
    },
  );

  const memberships: OrgMembership[] = rows.map((m) => ({
    organizationId: m.organizationId,
    organizationName: m.organizationName ?? "",
    roleId: m.roleId,
    roleName: m.roleName ?? "",
    status: m.status,
  }));
  const plansByOrg = new Map<string, SubscriptionPlan>(
    rows.flatMap((m) =>
      m.subscriptionPlan ? [[m.organizationId, m.subscriptionPlan] as const] : [],
    ),
  );

  const active = memberships.filter((m) => m.status === "active");
  const hint = opts.headers.get(ACTIVE_ORG_HEADER) ?? opts.activeOrgCookie ?? null;
  const activeOrganizationId =
    (hint && active.find((m) => m.organizationId === hint)?.organizationId) ??
    active[0]?.organizationId ??
    null;

  // The permission set is stable between role edits, so it is cached per
  // (user, org) for a minute and invalidated by the mutations that change it.
  let permissions = new Set<PermissionKey>();
  if (activeOrganizationId) {
    const cached = await getCachedPermissions(activeOrganizationId, user.id);
    if (cached) {
      permissions = new Set(cached);
    } else {
      const { data } = await authed.schema("api").rpc("current_user_permissions", {
        org_id: activeOrganizationId,
      });
      const keys = (data ?? []) as PermissionKey[];
      permissions = new Set(keys);
      await cachePermissions(activeOrganizationId, user.id, keys);
    }
  }

  const session: Session = {
    user: toSessionUser(user, profile?.displayName),
    memberships,
    activeOrganizationId,
    plan: (activeOrganizationId ? plansByOrg.get(activeOrganizationId) : undefined) ?? "trial",
    permissions,
    accessToken,
  };

  return {
    session,
    supabase: authed,
    db,
    headers: opts.headers,
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
