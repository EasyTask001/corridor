import { and, desc, eq, isNull, lt, or, schema, sql } from "@corridor/db";
import {
  NOTIFICATION_EVENT_TYPES,
  defaultChannelFor,
  notificationListInput,
  notificationMarkReadInput,
  notificationRuleInput,
  registerDeviceInput,
} from "@corridor/domain";
import { authedProcedure, orgProcedure, router } from "../trpc";
import { writeAudit } from "../services/audit";

const { notifications, notificationRules, userDevices } = schema;

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
      if (input.cursor) {
        const [createdAt, id] = input.cursor.split("|");
        if (createdAt && id) {
          conds.push(or(lt(notifications.createdAt, new Date(createdAt)), and(eq(notifications.createdAt, new Date(createdAt)), lt(notifications.id, id)))!);
        }
      }
      const where = and(...conds);
      const rows = await tx
          .select()
          .from(notifications)
          .where(where)
          .orderBy(desc(notifications.createdAt), desc(notifications.id))
          .limit(input.limit + 1);
      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page.at(-1);
      return { rows: page, nextCursor: hasMore && last ? `${new Date(last.createdAt).toISOString()}|${last.id}` : null };
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

  markRead: orgProcedure.input(notificationMarkReadInput).mutation(({ ctx, input }) =>
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

  /**
   * Register (or refresh) an Expo push token for the signed-in driver's
   * handset. Upserts on (user_id, expo_push_token) because Expo re-issues the
   * same token on every app start — a reinstall or a new phone simply adds a
   * row, and the fan-out sends to every device the user still has.
   */
  registerDevice: orgProcedure.input(registerDeviceInput).mutation(({ ctx, input }) =>
    ctx.rls(async (tx) => {
      const [row] = await tx
        .insert(userDevices)
        .values({
          userId: ctx.session.user.id,
          organizationId: ctx.orgId,
          expoPushToken: input.expoPushToken,
          platform: input.platform,
        })
        .onConflictDoUpdate({
          target: [userDevices.userId, userDevices.expoPushToken],
          set: { organizationId: ctx.orgId, platform: input.platform, updatedAt: sql`now()` },
        })
        .returning({
          id: userDevices.id,
          platform: userDevices.platform,
          createdAt: userDevices.createdAt,
        });
      // The token itself is a delivery address for this user's device; it is
      // deliberately not written into the audit payload.
      await writeAudit(
        tx,
        ctx.orgId,
        "notification.device_register",
        "user_device",
        row!.id,
        null,
        {
          platform: input.platform,
        },
      );
      return row!;
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
            channel: existing?.channel ?? defaultChannelFor(eventType),
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
