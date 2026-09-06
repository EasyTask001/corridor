import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createOrganizationInput,
  inviteMemberInput,
  updateOrganizationInput,
  uuid,
  type PermissionKey,
} from "@corridor/domain";
import { and, eq, isNull, or, schema } from "@corridor/db";
import { authedProcedure, orgProcedure, permissionProcedure, router } from "../trpc";

const { organizations, organizationMembers, roles, rolePermissions, permissions, userProfiles } =
  schema;

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
          const role = await tx.query.roles.findFirst({
            where: and(
              eq(roles.id, input.roleId),
              or(isNull(roles.organizationId), eq(roles.organizationId, ctx.orgId)),
            ),
          });
          if (!role) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown role" });

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
          // Email delivery is wired in Phase 5 (notifications). Until then the
          // inviter copies the link from the UI.
          return { memberId: row.id, invitePath: `/invite/${token}`, expiresAt: expires };
        }),
      ),

    updateRole: permissionProcedure("organization.members.manage")
      .input(z.object({ memberId: uuid, roleId: uuid }))
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
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
          if (!row) throw new TRPCError({ code: "NOT_FOUND" });
          return row;
        }),
      ),

    setStatus: permissionProcedure("organization.members.manage")
      .input(z.object({ memberId: uuid, status: z.enum(["active", "suspended"]) }))
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
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
          const [row] = await tx
            .update(organizationMembers)
            .set({ status: input.status })
            .where(eq(organizationMembers.id, input.memberId))
            .returning({ id: organizationMembers.id, status: organizationMembers.status });
          return row!;
        }),
      ),

    remove: permissionProcedure("organization.members.manage")
      .input(z.object({ memberId: uuid }))
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
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
          await tx.delete(organizationMembers).where(eq(organizationMembers.id, input.memberId));
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
