import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  carrierCodeRemoveInput,
  carrierCodeSetDefaultInput,
  carrierCodeUpsertInput,
  customRoleInput,
  createOrganizationInput,
  inviteMemberInput,
  PERMISSIONS,
  PERMISSION_KEYS,
  ssoConfigureInput,
  updateOrganizationInput,
  updateCustomRoleInput,
  uuid,
  type PermissionKey,
} from "@corridor/domain";
import {
  createSsoProvider,
  deleteSsoProvider,
  isMockProviderId,
  ssoMode,
  SsoProviderError,
  updateSsoProvider,
  type SsoMode,
  type SsoProviderInput,
} from "@corridor/integrations";
import { and, desc, eq, inArray, isNull, or, schema, sql, type RlsTransaction } from "@corridor/db";
import {
  authedProcedure,
  orgProcedure,
  permissionProcedure,
  router,
  type OrgContext,
} from "../trpc";
import { writeAudit } from "../services/audit";
import { invalidatePermissionCache } from "../infra/permission-cache";

const {
  organizations,
  organizationCarrierCodes,
  organizationMembers,
  organizationSso,
  roles,
  rolePermissions,
  permissions,
  userProfiles,
} = schema;

/** Postgres error code -> a message the dispatcher can act on. */
function mapCarrierCodeError(error: unknown): never {
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as Error & { code?: string }).code;
    if (code === "23505") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "This carrier code already exists for this regime",
      });
    }
    if (code === "23514") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid carrier code" });
    }
    current = current.cause;
  }
  throw error;
}

/** What a permission-affecting mutation gets in addition to its transaction. */
type PermissionMutation<T> = (
  tx: RlsTransaction,
  /**
   * Queue a user id that the post-mutation member list will not contain — a
   * member being removed, say. Ids already in the org are collected for you.
   */
  alsoInvalidate: (userId: string | null) => void,
) => Promise<T>;

/**
 * Run a mutation that can change what a member may do, then drop the cached
 * permission sets of everyone in the org.
 *
 * The invalidation deliberately happens **after** `ctx.rls` resolves, i.e.
 * after the transaction has committed. Deleting the keys mid-transaction would
 * leave a window in which a concurrent request reads the pre-change rows (the
 * mutation is not yet visible to it) and re-caches exactly the stale set the
 * delete was meant to remove.
 */
export async function withPermissionInvalidation<T>(
  ctx: OrgContext,
  run: PermissionMutation<T>,
): Promise<T> {
  const extraUserIds: (string | null)[] = [];
  const { result, memberUserIds } = await ctx.rls(async (tx) => {
    const result = await run(tx, (userId) => {
      extraUserIds.push(userId);
    });
    const rows = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, ctx.orgId));
    return { result, memberUserIds: rows.map((r) => r.userId) };
  });
  await invalidatePermissionCache(ctx.orgId, [...memberUserIds, ...extraUserIds]);
  return result;
}

function assertCanGrant(ctx: OrgContext, requested: readonly PermissionKey[]) {
  const missing = requested.filter((key) => !ctx.session.permissions.has(key));
  if (missing.length > 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Cannot grant permissions you do not hold: ${missing.join(", ")}`,
    });
  }
}

async function permissionKeysForRole(tx: RlsTransaction, roleId: string) {
  const rows = await tx
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(rolePermissions.roleId, roleId));
  return rows.map((row) => row.key as PermissionKey);
}

async function assignableRole(tx: RlsTransaction, ctx: OrgContext, roleId: string) {
  const role = await tx.query.roles.findFirst({
    where: and(
      eq(roles.id, roleId),
      or(isNull(roles.organizationId), eq(roles.organizationId, ctx.orgId)),
    ),
  });
  if (!role) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown role" });
  assertCanGrant(ctx, await permissionKeysForRole(tx, role.id));
  return role;
}

function mapRoleError(error: unknown): never {
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as Error & { code?: string }).code;
    if (code === "23505") {
      throw new TRPCError({ code: "CONFLICT", message: "A role with this name already exists" });
    }
    if (code === "23503") {
      throw new TRPCError({ code: "CONFLICT", message: "This role is assigned to a member" });
    }
    current = current.cause;
  }
  throw error;
}

/**
 * SAML SSO is *sold* with the Enterprise plan, so setting it up needs that
 * plan. Reading and tearing it down must not: `organization_sso.enforced` stays
 * true across a downgrade, and gating `remove` on the plan would leave the
 * tenant unable to turn enforcement off — locked out of password sign-in with
 * no self-service way back.
 */
function assertEnterprise(ctx: OrgContext) {
  if (ctx.session.plan !== "enterprise") {
    throw new TRPCError({ code: "FORBIDDEN", message: "SSO requires the Enterprise plan" });
  }
}

/**
 * SSO configuration is part of the organization profile, so it rides on
 * `organization.manage` — the same permission the RLS policies on
 * `organization_sso` enforce. `get` and `remove` need nothing more.
 */
const ssoProcedure = permissionProcedure("organization.manage");

/** …and `configure` adds the Enterprise plan gate on top. */
const ssoConfigureProcedure = ssoProcedure.use(({ ctx, next }) => {
  assertEnterprise(ctx);
  return next();
});

export interface SsoSettings {
  /** GoTrue's provider uuid, or a `mock-sso-…` id. */
  providerId: string;
  domains: string[];
  enforced: boolean;
  /** `"mock"` when this configuration was never registered with a real IdP. */
  mode: SsoMode;
  updatedAt: Date;
}

type SsoRow = typeof organizationSso.$inferSelect;

function toSsoSettings(row: SsoRow): SsoSettings {
  return {
    providerId: row.providerId,
    domains: row.domains,
    enforced: row.enforced,
    mode: isMockProviderId(row.providerId) ? "mock" : "saml",
    updatedAt: row.updatedAt,
  };
}

/**
 * Turn a rejection from Supabase Auth into an error the operator can act on.
 * Without this tRPC would report an opaque INTERNAL_SERVER_ERROR for what is
 * nearly always a typo in the metadata URL or an IdP the instance cannot reach.
 */
function mapSsoError(error: unknown): never {
  if (error instanceof SsoProviderError) {
    throw new TRPCError({
      code: error.status >= 500 ? "BAD_GATEWAY" : "BAD_REQUEST",
      message: `Supabase Auth rejected the SAML configuration: ${error.message}${
        error.status >= 500 ? " (is the metadata URL reachable from Auth?)" : ""
      }`,
      cause: error,
    });
  }
  throw error;
}

/**
 * What the audit log records about an SSO change. Deliberately *not* the
 * metadata: an IdP metadata document is up to half a megabyte of XML and would
 * bury the rest of the trail, and the URL it came from is already on the row.
 */
function auditableSso(row: SsoRow | null | undefined) {
  return row ? { providerId: row.providerId, domains: row.domains, enforced: row.enforced } : null;
}

export const organizationRouter = router({
  /** Who am I, which orgs am I in, what can I do in the active one. */
  me: authedProcedure.query(({ ctx }) => ({
    user: ctx.session.user,
    memberships: ctx.session.memberships,
    activeOrganizationId: ctx.session.activeOrganizationId,
    permissions: [...ctx.session.permissions],
  })),

  /** Onboarding: create org + Owner membership atomically (SECURITY DEFINER RPC). */
  create: authedProcedure.input(createOrganizationInput).mutation(async ({ ctx, input }) => {
    const { data, error } = await ctx.supabase.rpc("create_organization_with_owner", {
      p_name: input.name,
      p_legal_name: input.legalName ?? null,
      p_scac_code: input.scacCode ?? null,
      p_canadian_carrier_code: input.canadianCarrierCode ?? null,
      p_us_dot_number: input.usDotNumber ?? null,
      p_mc_number: input.mcNumber ?? null,
    });
    if (error) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    return { organizationId: data as string };
  }),

  get: orgProcedure.query(({ ctx }) =>
    ctx.rls(async (tx) => {
      const org = await tx.query.organizations.findFirst({
        where: eq(organizations.id, ctx.orgId),
      });
      if (!org) throw new TRPCError({ code: "NOT_FOUND" });
      return org;
    }),
  ),

  update: permissionProcedure("organization.manage")
    .input(updateOrganizationInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const before = await tx.query.organizations.findFirst({
          where: eq(organizations.id, ctx.orgId),
        });
        if (!before) throw new TRPCError({ code: "NOT_FOUND" });
        const [row] = await tx
          .update(organizations)
          .set({
            ...(input.name !== undefined && { name: input.name }),
            ...(input.legalName !== undefined && { legalName: input.legalName }),
            ...(input.scacCode !== undefined && { scacCode: input.scacCode }),
            ...(input.canadianCarrierCode !== undefined && {
              canadianCarrierCode: input.canadianCarrierCode,
            }),
            ...(input.usDotNumber !== undefined && { usDotNumber: input.usDotNumber }),
            ...(input.mcNumber !== undefined && { mcNumber: input.mcNumber }),
            ...(input.filerCode !== undefined && { filerCode: input.filerCode }),
            ...(input.billingEmail !== undefined && { billingEmail: input.billingEmail }),
          })
          .where(eq(organizations.id, ctx.orgId))
          .returning();
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        await writeAudit(
          tx,
          ctx.orgId,
          "organization.update",
          "organization",
          ctx.orgId,
          before,
          row,
        );
        return row;
      }),
    ),

  /**
   * The ACE/ACI carrier codes this org files under (migration 0018). Gated
   * entirely on `organization.manage` — the settings panel that surfaces this
   * only renders for a manager in the first place.
   */
  carrierCodes: router({
    list: permissionProcedure("organization.manage").query(({ ctx }) =>
      ctx.rls((tx) =>
        tx
          .select()
          .from(organizationCarrierCodes)
          .where(eq(organizationCarrierCodes.organizationId, ctx.orgId))
          .orderBy(
            organizationCarrierCodes.regime,
            desc(organizationCarrierCodes.isDefault),
            organizationCarrierCodes.code,
          ),
      ),
    ),

    upsert: permissionProcedure("organization.manage")
      .input(carrierCodeUpsertInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const { id, ...fields } = input;
          if (id) {
            const before = await tx.query.organizationCarrierCodes.findFirst({
              where: and(
                eq(organizationCarrierCodes.id, id),
                eq(organizationCarrierCodes.organizationId, ctx.orgId),
              ),
            });
            if (!before) throw new TRPCError({ code: "NOT_FOUND" });
            const [row] = await tx
              .update(organizationCarrierCodes)
              .set({
                regime: fields.regime,
                code: fields.code,
                label: fields.label ?? null,
                ...(fields.isDefault !== undefined && { isDefault: fields.isDefault }),
              })
              .where(eq(organizationCarrierCodes.id, id))
              .returning()
              .catch(mapCarrierCodeError);
            await writeAudit(
              tx,
              ctx.orgId,
              "organization.carrier_code_update",
              "organization_carrier_code",
              id,
              before,
              row,
            );
            return row!;
          }
          const [row] = await tx
            .insert(organizationCarrierCodes)
            .values({
              organizationId: ctx.orgId,
              regime: fields.regime,
              code: fields.code,
              label: fields.label ?? null,
              isDefault: fields.isDefault ?? false,
            })
            .returning()
            .catch(mapCarrierCodeError);
          await writeAudit(
            tx,
            ctx.orgId,
            "organization.carrier_code_create",
            "organization_carrier_code",
            row!.id,
            null,
            row,
          );
          return row!;
        }),
      ),

    remove: permissionProcedure("organization.manage")
      .input(carrierCodeRemoveInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const [removed] = await tx
            .delete(organizationCarrierCodes)
            .where(
              and(
                eq(organizationCarrierCodes.id, input.id),
                eq(organizationCarrierCodes.organizationId, ctx.orgId),
              ),
            )
            .returning();
          if (!removed) throw new TRPCError({ code: "NOT_FOUND" });
          await writeAudit(
            tx,
            ctx.orgId,
            "organization.carrier_code_remove",
            "organization_carrier_code",
            input.id,
            removed,
            null,
          );
          return { id: input.id };
        }),
      ),

    /** Flip the default within the code's own regime; at most one may hold it. */
    setDefault: permissionProcedure("organization.manage")
      .input(carrierCodeSetDefaultInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const target = await tx.query.organizationCarrierCodes.findFirst({
            where: and(
              eq(organizationCarrierCodes.id, input.id),
              eq(organizationCarrierCodes.organizationId, ctx.orgId),
            ),
          });
          if (!target) throw new TRPCError({ code: "NOT_FOUND" });
          // Two statements, not one UPDATE ... OR: the partial unique index is
          // checked at the end of each statement, so clearing the old default
          // first (however many rows that turns out to be — zero or one) keeps
          // "set this row's default" from ever colliding with it.
          await tx
            .update(organizationCarrierCodes)
            .set({ isDefault: false })
            .where(
              and(
                eq(organizationCarrierCodes.organizationId, ctx.orgId),
                eq(organizationCarrierCodes.regime, target.regime),
                eq(organizationCarrierCodes.isDefault, true),
              ),
            );
          const [row] = await tx
            .update(organizationCarrierCodes)
            .set({ isDefault: true })
            .where(eq(organizationCarrierCodes.id, input.id))
            .returning();
          await writeAudit(
            tx,
            ctx.orgId,
            "organization.carrier_code_set_default",
            "organization_carrier_code",
            input.id,
            { isDefault: target.isDefault },
            { isDefault: true },
          );
          return row!;
        }),
      ),
  }),

  /**
   * SAML single sign-on. Supabase Auth owns the provider and the redirect; this
   * router owns which organization it belongs to, which domains it claims, and
   * whether password sign-in is still allowed for them.
   */
  sso: router({
    get: ssoProcedure.query(({ ctx }) =>
      ctx.rls(async (tx) => {
        const row = await tx.query.organizationSso.findFirst({
          where: eq(organizationSso.organizationId, ctx.orgId),
        });
        return {
          /** Whether *this deployment* can register real providers at all. */
          instanceMode: ssoMode(),
          config: row ? toSsoSettings(row) : null,
        };
      }),
    ),

    /**
     * Register or re-register the tenant's IdP, then mirror it locally.
     *
     * The GoTrue call happens between two transactions rather than inside one,
     * so a Postgres transaction is never held open across an HTTP request (the
     * pattern `billing.checkout` already uses). The cost is a window in which
     * the provider exists in Auth but not here — closed by deleting the
     * just-created provider if the mirror write fails, which also keeps a retry
     * from tripping GoTrue's "domain already claimed" rejection.
     */
    configure: ssoConfigureProcedure.input(ssoConfigureInput).mutation(async ({ ctx, input }) => {
      const before = await ctx.rls((tx) =>
        tx.query.organizationSso.findFirst({
          where: eq(organizationSso.organizationId, ctx.orgId),
        }),
      );

      const providerInput: SsoProviderInput = {
        metadataUrl: input.metadataUrl,
        metadataXml: input.metadataXml,
        domains: input.domains,
      };
      const provider = await (
        before
          ? updateSsoProvider(before.providerId, providerInput)
          : createSsoProvider(providerInput)
      ).catch(mapSsoError);

      try {
        const row = await ctx.rls(async (tx) => {
          // TOCTOU guard. `before` was read in an earlier transaction, with a
          // GoTrue round-trip since; a concurrent `configure` may have created
          // or replaced the provider in the meantime. Serialise on the org
          // (the advisory lock also covers the not-yet-existing row, which
          // `for update` cannot) and re-read before writing: if the world
          // moved, bail out and let the catch below delete the provider we
          // just created rather than orphaning it in Auth.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext('organization_sso:' || ${ctx.orgId}))`,
          );
          const [current] = await tx
            .select({ providerId: organizationSso.providerId })
            .from(organizationSso)
            .where(eq(organizationSso.organizationId, ctx.orgId))
            .for("update");
          if ((current?.providerId ?? null) !== (before?.providerId ?? null)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "SSO was reconfigured concurrently — reload and try again",
            });
          }
          const [saved] = await tx
            .insert(organizationSso)
            .values({
              organizationId: ctx.orgId,
              providerId: provider.id,
              domains: input.domains,
              enforced: input.enforced,
            })
            .onConflictDoUpdate({
              target: organizationSso.organizationId,
              set: {
                providerId: provider.id,
                domains: input.domains,
                enforced: input.enforced,
              },
            })
            .returning();
          if (!saved) throw new TRPCError({ code: "FORBIDDEN", message: "Not permitted" });
          await writeAudit(
            tx,
            ctx.orgId,
            "organization.sso_configure",
            "organization_sso",
            ctx.orgId,
            auditableSso(before),
            auditableSso(saved),
          );
          return saved;
        });
        return toSsoSettings(row);
      } catch (error) {
        // Compensate: the provider we just created has no owner any more.
        if (!before) {
          await deleteSsoProvider(provider.id).catch(() => undefined);
        }
        throw error;
      }
    }),

    /** Turn SSO off: the provider goes from Auth, the mirror row from here. */
    remove: ssoProcedure.mutation(async ({ ctx }) => {
      const before = await ctx.rls((tx) =>
        tx.query.organizationSso.findFirst({
          where: eq(organizationSso.organizationId, ctx.orgId),
        }),
      );
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });

      await deleteSsoProvider(before.providerId).catch(mapSsoError);
      await ctx.rls(async (tx) => {
        const deleted = await tx
          .delete(organizationSso)
          .where(eq(organizationSso.organizationId, ctx.orgId))
          .returning({ organizationId: organizationSso.organizationId });
        if (deleted.length === 0) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Not permitted" });
        }
        await writeAudit(
          tx,
          ctx.orgId,
          "organization.sso_remove",
          "organization_sso",
          ctx.orgId,
          auditableSso(before),
          null,
        );
      });
      return { organizationId: ctx.orgId };
    }),
  }),

  roles: router({
    list: orgProcedure.query(({ ctx }) =>
      ctx.rls(async (tx) => {
        const rows = await tx
          .select({
            id: roles.id,
            name: roles.name,
            isSystem: roles.isSystem,
            organizationId: roles.organizationId,
            permissionKey: permissions.key,
          })
          .from(roles)
          .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
          .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(or(isNull(roles.organizationId), eq(roles.organizationId, ctx.orgId)));

        const byId = new Map<
          string,
          {
            id: string;
            name: string;
            isSystem: boolean;
            organizationId: string | null;
            permissions: PermissionKey[];
          }
        >();
        for (const r of rows) {
          const entry = byId.get(r.id) ?? {
            id: r.id,
            name: r.name,
            isSystem: r.isSystem,
            organizationId: r.organizationId,
            permissions: [],
          };
          if (r.permissionKey) entry.permissions.push(r.permissionKey as PermissionKey);
          byId.set(r.id, entry);
        }
        return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
      }),
    ),

    catalog: permissionProcedure("organization.roles.manage").query(({ ctx }) =>
      PERMISSION_KEYS.map((key) => ({
        key,
        ...PERMISSIONS[key],
        assignable: ctx.session.permissions.has(key),
      })),
    ),

    create: permissionProcedure("organization.roles.manage")
      .input(customRoleInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          assertCanGrant(ctx, input.permissions);
          try {
            const grants = await tx
              .select({ id: permissions.id, key: permissions.key })
              .from(permissions)
              .where(inArray(permissions.key, input.permissions));
            if (grants.length !== input.permissions.length) {
              throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown permission" });
            }
            const [role] = await tx
              .insert(roles)
              .values({ organizationId: ctx.orgId, name: input.name, isSystem: false })
              .returning();
            await tx
              .insert(rolePermissions)
              .values(grants.map((grant) => ({ roleId: role!.id, permissionId: grant.id })));
            const saved = {
              ...role!,
              permissions: grants.map((grant) => grant.key as PermissionKey),
            };
            await writeAudit(tx, ctx.orgId, "role.create", "role", role!.id, null, saved);
            return saved;
          } catch (error) {
            mapRoleError(error);
          }
        }),
      ),

    update: permissionProcedure("organization.roles.manage")
      .input(updateCustomRoleInput)
      .mutation(({ ctx, input }) =>
        withPermissionInvalidation(ctx, async (tx) => {
          const before = await tx.query.roles.findFirst({
            where: and(
              eq(roles.id, input.id),
              eq(roles.organizationId, ctx.orgId),
              eq(roles.isSystem, false),
            ),
          });
          if (!before) throw new TRPCError({ code: "NOT_FOUND" });
          const previousPermissions = await permissionKeysForRole(tx, before.id);
          const previous = { ...before, permissions: previousPermissions };
          const previousSet = new Set(previousPermissions);
          assertCanGrant(
            ctx,
            input.permissions.filter((key) => !previousSet.has(key)),
          );

          try {
            const grants = await tx
              .select({ id: permissions.id, key: permissions.key })
              .from(permissions)
              .where(inArray(permissions.key, input.permissions));
            if (grants.length !== input.permissions.length) {
              throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown permission" });
            }
            const [role] = await tx
              .update(roles)
              .set({ name: input.name })
              .where(eq(roles.id, input.id))
              .returning();
            await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, input.id));
            await tx
              .insert(rolePermissions)
              .values(grants.map((grant) => ({ roleId: input.id, permissionId: grant.id })));
            const saved = {
              ...role!,
              permissions: grants.map((grant) => grant.key as PermissionKey),
            };
            await writeAudit(tx, ctx.orgId, "role.update", "role", input.id, previous, saved);
            return saved;
          } catch (error) {
            mapRoleError(error);
          }
        }),
      ),

    delete: permissionProcedure("organization.roles.manage")
      .input(z.object({ id: uuid }))
      .mutation(({ ctx, input }) =>
        withPermissionInvalidation(ctx, async (tx) => {
          const role = await tx.query.roles.findFirst({
            where: and(
              eq(roles.id, input.id),
              eq(roles.organizationId, ctx.orgId),
              eq(roles.isSystem, false),
            ),
          });
          if (!role) throw new TRPCError({ code: "NOT_FOUND" });
          const before = { ...role, permissions: await permissionKeysForRole(tx, role.id) };
          try {
            await tx.delete(roles).where(eq(roles.id, role.id));
            await writeAudit(tx, ctx.orgId, "role.delete", "role", role.id, before, null);
            return { id: role.id };
          } catch (error) {
            mapRoleError(error);
          }
        }),
      ),
  }),

  members: router({
    list: permissionProcedure("organization.members.read").query(({ ctx }) =>
      ctx.rls((tx) =>
        tx
          .select({
            id: organizationMembers.id,
            organizationId: organizationMembers.organizationId,
            userId: organizationMembers.userId,
            roleId: organizationMembers.roleId,
            roleName: roles.name,
            status: organizationMembers.status,
            invitedEmail: organizationMembers.invitedEmail,
            displayName: userProfiles.displayName,
            createdAt: organizationMembers.createdAt,
          })
          .from(organizationMembers)
          .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
          .leftJoin(userProfiles, eq(userProfiles.userId, organizationMembers.userId))
          .where(eq(organizationMembers.organizationId, ctx.orgId))
          .orderBy(organizationMembers.createdAt),
      ),
    ),

    invite: permissionProcedure("organization.members.manage")
      .input(inviteMemberInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          await assignableRole(tx, ctx, input.roleId);

          const token = randomBytes(24).toString("base64url");
          const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
          const [row] = await tx
            .insert(organizationMembers)
            .values({
              organizationId: ctx.orgId,
              roleId: input.roleId,
              status: "invited",
              invitedEmail: input.email,
              inviteToken: token,
              inviteExpiresAt: expires,
              invitedBy: ctx.session.user.id,
            })
            .onConflictDoNothing()
            .returning({ id: organizationMembers.id });
          if (!row) {
            throw new TRPCError({ code: "CONFLICT", message: "Already invited or a member" });
          }
          await writeAudit(tx, ctx.orgId, "member.invite", "organization_member", row.id, null, {
            email: input.email,
            roleId: input.roleId,
            status: "invited",
          });
          // Email delivery is wired in Phase 5 (notifications). Until then the
          // inviter copies the link from the UI.
          return { memberId: row.id, invitePath: `/invite/${token}`, expiresAt: expires };
        }),
      ),

    updateRole: permissionProcedure("organization.members.manage")
      .input(z.object({ memberId: uuid, roleId: uuid }))
      .mutation(({ ctx, input }) =>
        withPermissionInvalidation(ctx, async (tx, alsoInvalidate) => {
          const target = await tx.query.organizationMembers.findFirst({
            where: and(
              eq(organizationMembers.id, input.memberId),
              eq(organizationMembers.organizationId, ctx.orgId),
            ),
          });
          if (!target) throw new TRPCError({ code: "NOT_FOUND" });
          if (target.userId === ctx.session.user.id) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot change your own role" });
          }
          assertCanGrant(ctx, await permissionKeysForRole(tx, target.roleId));
          await assignableRole(tx, ctx, input.roleId);

          const [row] = await tx
            .update(organizationMembers)
            .set({ roleId: input.roleId })
            .where(
              and(
                eq(organizationMembers.id, input.memberId),
                eq(organizationMembers.organizationId, ctx.orgId),
              ),
            )
            .returning({ id: organizationMembers.id });
          await writeAudit(
            tx,
            ctx.orgId,
            "member.role_update",
            "organization_member",
            input.memberId,
            { roleId: target.roleId },
            { roleId: input.roleId },
          );
          alsoInvalidate(target.userId);
          return row;
        }),
      ),

    setStatus: permissionProcedure("organization.members.manage")
      .input(z.object({ memberId: uuid, status: z.enum(["active", "suspended"]) }))
      .mutation(({ ctx, input }) =>
        withPermissionInvalidation(ctx, async (tx, alsoInvalidate) => {
          const target = await tx.query.organizationMembers.findFirst({
            where: and(
              eq(organizationMembers.id, input.memberId),
              eq(organizationMembers.organizationId, ctx.orgId),
            ),
          });
          if (!target) throw new TRPCError({ code: "NOT_FOUND" });
          if (target.userId === ctx.session.user.id) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot change your own status" });
          }
          assertCanGrant(ctx, await permissionKeysForRole(tx, target.roleId));
          const [row] = await tx
            .update(organizationMembers)
            .set({ status: input.status })
            .where(eq(organizationMembers.id, input.memberId))
            .returning({ id: organizationMembers.id, status: organizationMembers.status });
          await writeAudit(
            tx,
            ctx.orgId,
            "member.status_update",
            "organization_member",
            input.memberId,
            { status: target.status },
            { status: input.status },
          );
          alsoInvalidate(target.userId);
          return row!;
        }),
      ),

    remove: permissionProcedure("organization.members.manage")
      .input(z.object({ memberId: uuid }))
      .mutation(({ ctx, input }) =>
        withPermissionInvalidation(ctx, async (tx, alsoInvalidate) => {
          const target = await tx.query.organizationMembers.findFirst({
            where: and(
              eq(organizationMembers.id, input.memberId),
              eq(organizationMembers.organizationId, ctx.orgId),
            ),
          });
          if (!target) throw new TRPCError({ code: "NOT_FOUND" });
          if (target.userId === ctx.session.user.id) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot remove yourself" });
          }
          assertCanGrant(ctx, await permissionKeysForRole(tx, target.roleId));
          await tx.delete(organizationMembers).where(eq(organizationMembers.id, input.memberId));
          await writeAudit(
            tx,
            ctx.orgId,
            "member.remove",
            "organization_member",
            input.memberId,
            {
              userId: target.userId,
              invitedEmail: target.invitedEmail,
              roleId: target.roleId,
              status: target.status,
            },
            null,
          );
          // The row is gone, so the member list read after this will not have it.
          alsoInvalidate(target.userId);
          return { id: input.memberId };
        }),
      ),

    /** Accept an invitation token for the signed-in user. */
    acceptInvite: authedProcedure
      .input(z.object({ token: z.string().min(10) }))
      .mutation(async ({ ctx, input }) => {
        const { data, error } = await ctx.supabase.rpc("accept_invitation", {
          p_token: input.token,
        });
        if (error) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        return { organizationId: data as string };
      }),
  }),
});
