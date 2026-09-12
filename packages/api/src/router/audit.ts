import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, ilike, or, schema, sql } from "@corridor/db";
import { containsPattern } from "../infra/like";
import { anyPermissionProcedure, permissionProcedure, router } from "../trpc";
import { HISTORY_ENTITY_PERMISSIONS, historyEntityType } from "../services/history";

const { auditLog, userProfiles } = schema;

const forEntityInput = z.object({
  entityType: historyEntityType,
  entityId: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(100).default(50),
});

const auditListInput = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(200).default(100),
  offset: z.number().int().min(0).default(0),
});

export const auditRouter = router({
  /**
   * One record's history (Task 13). Whoever may read the record may read what
   * happened to it, so the gate is that entity's read permission rather than
   * the org-wide audit_log.read — and RLS on audit_log still applies.
   */
  forEntity: anyPermissionProcedure(...new Set(Object.values(HISTORY_ENTITY_PERMISSIONS)))
    .input(forEntityInput)
    .query(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const needed = HISTORY_ENTITY_PERMISSIONS[input.entityType];
        if (!ctx.session.permissions.has(needed)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `Reading ${input.entityType} history needs ${needed}`,
          });
        }
        return tx
          .select({
            id: auditLog.id,
            actorId: auditLog.actorId,
            actorName: userProfiles.displayName,
            action: auditLog.action,
            before: auditLog.before,
            after: auditLog.after,
            createdAt: auditLog.createdAt,
          })
          .from(auditLog)
          .leftJoin(userProfiles, eq(userProfiles.userId, auditLog.actorId))
          .where(
            and(
              eq(auditLog.organizationId, ctx.orgId),
              eq(auditLog.entityType, input.entityType),
              eq(auditLog.entityId, input.entityId),
            ),
          )
          .orderBy(desc(auditLog.createdAt))
          .limit(input.limit);
      }),
    ),

  list: permissionProcedure("audit_log.read")
    .input(auditListInput)
    .query(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const conditions = [eq(auditLog.organizationId, ctx.orgId)];
        if (input.search) {
          const pattern = containsPattern(input.search);
          conditions.push(
            or(
              ilike(auditLog.action, pattern),
              ilike(auditLog.entityType, pattern),
              ilike(auditLog.entityId, pattern),
            )!,
          );
        }
        const where = and(...conditions);
        const [rows, count] = await Promise.all([
          tx
            .select({
              id: auditLog.id,
              actorId: auditLog.actorId,
              actorName: userProfiles.displayName,
              action: auditLog.action,
              entityType: auditLog.entityType,
              entityId: auditLog.entityId,
              before: auditLog.before,
              after: auditLog.after,
              createdAt: auditLog.createdAt,
            })
            .from(auditLog)
            .leftJoin(userProfiles, eq(userProfiles.userId, auditLog.actorId))
            .where(where)
            .orderBy(desc(auditLog.createdAt))
            .limit(input.limit)
            .offset(input.offset),
          tx
            .select({ value: sql<number>`count(*)::int` })
            .from(auditLog)
            .where(where),
        ]);
        return { rows, total: count[0]?.value ?? 0 };
      }),
    ),
});
