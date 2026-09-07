import { z } from "zod";
import { and, desc, eq, ilike, or, schema, sql } from "@corridor/db";
import { permissionProcedure, router } from "../trpc";

const { auditLog, userProfiles } = schema;

const auditListInput = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(200).default(100),
  offset: z.number().int().min(0).default(0),
});

export const auditRouter = router({
  list: permissionProcedure("audit_log.read")
    .input(auditListInput)
    .query(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const conditions = [eq(auditLog.organizationId, ctx.orgId)];
        if (input.search) {
          const pattern = `%${input.search.replace(/[%_\\]/g, "\\$&")}%`;
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
