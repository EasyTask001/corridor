import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  customRoleInput,
  createOrganizationInput,
  inviteMemberInput,
  PERMISSIONS,
  PERMISSION_KEYS,
  updateOrganizationInput,
  updateCustomRoleInput,
  uuid,
  type PermissionKey,
} from "@corridor/domain";
import { and, eq, inArray, isNull, or, schema, type RlsTransaction } from "@corridor/db";
import {
  authedProcedure,
  orgProcedure,
  permissionProcedure,
  router,
  type OrgContext,
} from "../trpc";
import { writeAudit } from "../services/audit";
import { invalidatePermissionCache } from "../infra/permission-cache";

const { organizations, organizationMembers, roles, rolePermissions, permissions, userProfiles } =
  schema;

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
