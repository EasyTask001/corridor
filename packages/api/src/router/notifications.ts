import { z } from "zod";
import { and, desc, eq, isNull, schema, sql } from "@corridor/db";
import {
  NOTIFICATION_EVENT_TYPES,
  notificationListInput,
  notificationRuleInput,
  uuid,
} from "@corridor/domain";
import { authedProcedure, orgProcedure, router } from "../trpc";
import { writeAudit } from "../services/audit";

const { notifications, notificationRules } = schema;

/**
 * Notifications are inherently per-user, not per-permission: RLS already
 * scopes every row to `user_id = auth.uid()`, so these procedures only need
 * an active org membership (orgProcedure), not a specific permission.
 */
export const notificationsRouter = router({
  list: orgProcedure.input(notificationListInput).query(({ ctx, input }) =>
    ctx.rls(async (tx) => {
      const conds = [
        eq(notifications.userId, ctx.session.user.id),
        eq(notifications.organizationId, ctx.orgId),
      ];
      if (input.unreadOnly) conds.push(isNull(notifications.readAt));
      const where = and(...conds);
      const [rows, counts] = await Promise.all([
        tx
          .select()
          .from(notifications)
          .where(where)
          .orderBy(desc(notifications.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(notifications)
          .where(where),
      ]);
      return { rows, total: counts[0]?.count ?? 0 };
    }),
  ),

  unreadCount: orgProcedure.query(({ ctx }) =>
    ctx.rls(async (tx) => {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, ctx.session.user.id),
            eq(notifications.organizationId, ctx.orgId),
            isNull(notifications.readAt),
          ),
        );
      return row?.count ?? 0;
    }),
  ),

  markRead: orgProcedure.input(z.object({ id: uuid })).mutation(({ ctx, input }) =>
    ctx.rls(async (tx) => {
      const [row] = await tx
        .update(notifications)
        .set({ readAt: sql`now()` })
        .where(and(eq(notifications.id, input.id), eq(notifications.userId, ctx.session.user.id)))
        .returning({ id: notifications.id });
      return row ?? { id: input.id };
    }),
  ),

  markAllRead: orgProcedure.mutation(({ ctx }) =>
    ctx.rls(async (tx) => {
      const rows = await tx
        .update(notifications)
        .set({ readAt: sql`now()` })
        .where(
          and(
            eq(notifications.userId, ctx.session.user.id),
            eq(notifications.organizationId, ctx.orgId),
            isNull(notifications.readAt),
          ),
        )
        .returning({ id: notifications.id });
      return { count: rows.length };
    }),
  ),

  rules: router({
    /** All event types with the caller's current preference (defaults when no row exists yet). */
    list: orgProcedure.query(({ ctx }) =>
      ctx.rls(async (tx) => {
        const rows = await tx
          .select()
          .from(notificationRules)
          .where(
            and(
              eq(notificationRules.userId, ctx.session.user.id),
              eq(notificationRules.organizationId, ctx.orgId),
            ),
          );
        const byType = new Map(rows.map((r) => [r.eventType, r]));
        return (
          Object.keys(NOTIFICATION_EVENT_TYPES) as (keyof typeof NOTIFICATION_EVENT_TYPES)[]
        ).map((eventType) => {
          const def = NOTIFICATION_EVENT_TYPES[eventType];
          const existing = byType.get(eventType);
          return {
            eventType,
            label: def.label,
            description: def.description,
            enabled: existing?.enabled ?? true,
            channel: existing?.channel ?? ["in_app"],
            filters: existing?.filters ?? {},
          };
        });
      }),
    ),

    upsert: orgProcedure.input(notificationRuleInput).mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const [before] = await tx
          .select()
          .from(notificationRules)
          .where(
            and(
              eq(notificationRules.organizationId, ctx.orgId),
              eq(notificationRules.userId, ctx.session.user.id),
              eq(notificationRules.eventType, input.eventType),
            ),
          )
          .limit(1);
        const [row] = await tx
          .insert(notificationRules)
          .values({
            organizationId: ctx.orgId,
            userId: ctx.session.user.id,
            eventType: input.eventType,
            enabled: input.enabled,
            channel: input.channel,
            filters: input.filters,
          })
          .onConflictDoUpdate({
            target: [
              notificationRules.organizationId,
              notificationRules.userId,
              notificationRules.eventType,
            ],
            set: { enabled: input.enabled, channel: input.channel, filters: input.filters },
          })
          .returning();
        await writeAudit(
          tx,
          ctx.orgId,
          "notification.rule_update",
          "notification_rule",
          row!.id,
          before ?? null,
          row!,
        );
        return row!;
      }),
    ),
  }),
});

/** Exposed for the app shell to greet a user before an org is selected (rarely needed). */
export const notificationsPublicRouter = router({
  ping: authedProcedure.query(() => ({ ok: true })),
});
