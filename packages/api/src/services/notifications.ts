/**
 * Two delivery shapes sit here.
 *
 * `notifyOrganization` fans out to every org member holding the permission an
 * event type requires (see NOTIFICATION_EVENT_TYPES), respecting each member's
 * own opt-out/channel preference. Insertion happens inside `notify_organization`
 * (SECURITY DEFINER), so it works identically from a user's RLS transaction or a
 * service-role background job — callers never target another user's row directly.
 *
 * `notifyUser` delivers a *targeted* event (currently `movement.assigned`) to one
 * recipient. It runs wholly in a service-role transaction, which is what lets it
 * write a row the acting user has no RLS permission to write, in the same way
 * `writeSystemAudit` does.
 *
 * Push, on both paths, also needs the service role: `push_tokens_for` is granted
 * to `service_role` only (migration 0015), because a push token is a bearer
 * capability and must not be readable by any authenticated caller.
 */
import {
  NOTIFICATION_EVENT_TYPES,
  defaultChannelFor,
  type NotificationChannel,
  type NotificationEventType,
} from "@corridor/domain";
import { sendEmail, sendExpoPush, type ExpoPushMessage } from "@corridor/integrations";
import {
  and,
  eq,
  getDb,
  schema,
  sql,
  withServiceRole,
  type DatabaseClient,
  type RlsTransaction,
} from "@corridor/db";
import { logIntegrationEvent } from "./customs";

const { authUsers, drivers, notificationRules, notifications } = schema;

export interface NotifyInput {
  orgId: string;
  eventType: NotificationEventType;
  title: string;
  body?: string;
  linkPath?: string;
}

export interface NotifyUserInput extends NotifyInput {
  /** auth.users.id of the single recipient. */
  userId: string;
}

type NotifiedRow = Record<string, unknown> & {
  notification_id: string;
  user_id: string;
  email: string;
  channel: string[];
};

type PushTokenRow = Record<string, unknown> & {
  user_id: string;
  expo_push_token: string;
  platform: string;
};

/**
 * Creates the notification rows and, for recipients whose channel includes
 * 'email' or 'push', sends (or mock-sends) it — logged as an integration_event
 * the same way customs/Stripe calls are, for one consistent audit trail.
 */
export async function notifyOrganization(
  tx: RlsTransaction,
  input: NotifyInput,
  /** Service-role connection for the push step; defaults to the pooled client. */
  db?: DatabaseClient,
) {
  const permission = NOTIFICATION_EVENT_TYPES[input.eventType].permission;
  const rows = await tx.execute<NotifiedRow>(sql`
    select * from public.notify_organization(
      ${input.orgId}::uuid, ${input.eventType}, ${permission}, ${input.title}, ${input.body ?? null}, ${input.linkPath ?? null}
    )
  `);

  const emailTargets = rows.filter((r) => r.channel?.includes("email"));
  for (const r of emailTargets) {
    await deliverEmail(tx, input, r.email);
  }

  const pushed = await deliverPush(
    db,
    input,
    rows.filter((r) => r.channel?.includes("push")).map((r) => r.user_id),
  );

  return { notified: rows.length, emailed: emailTargets.length, pushed };
}

/**
 * Deliver a targeted event to one member. Returns `{ notified: 0 }` when the
 * recipient turned the event off; an unknown user id simply produces nothing.
 *
 * Everything runs under the service role, so callers MUST have established that
 * `userId` belongs to `orgId` — every caller here resolves the recipient from an
 * org-scoped row it already read under RLS.
 */
export async function notifyUser(db: DatabaseClient, input: NotifyUserInput) {
  return withServiceRole(db, async (tx) => {
    const [rule] = await tx
      .select({ enabled: notificationRules.enabled, channel: notificationRules.channel })
      .from(notificationRules)
      .where(
        and(
          eq(notificationRules.organizationId, input.orgId),
          eq(notificationRules.userId, input.userId),
          eq(notificationRules.eventType, input.eventType),
        ),
      )
      .limit(1);
    if (rule && !rule.enabled) return { notified: 0, emailed: 0, pushed: 0 };

    const channel: NotificationChannel[] = rule?.channel ?? defaultChannelFor(input.eventType);

    const [row] = await tx
      .insert(notifications)
      .values({
        organizationId: input.orgId,
        userId: input.userId,
        type: input.eventType,
        title: input.title,
        body: input.body ?? null,
        linkPath: input.linkPath ?? null,
        channel,
      })
      .returning({ id: notifications.id });
    if (!row) return { notified: 0, emailed: 0, pushed: 0 };

    let emailed = 0;
    if (channel.includes("email")) {
      const [user] = await tx
        .select({ email: authUsers.email })
        .from(authUsers)
        .where(eq(authUsers.id, input.userId))
        .limit(1);
      if (user?.email) {
        await deliverEmail(tx, input, user.email);
        emailed = 1;
      }
    }

    const pushed = channel.includes("push") ? await deliverPushInTx(tx, input, [input.userId]) : 0;

    return { notified: 1, emailed, pushed };
  });
}

/**
 * `movement.assigned`: tell the driver a dispatcher just put them on a load.
 *
 * Silent when the driver record has no linked auth user (a paper-only driver),
 * and silent when the driver *is* the acting user — nobody needs a notification
 * about their own edit.
 */
export async function notifyDriverAssigned(
  tx: RlsTransaction,
  db: DatabaseClient,
  input: {
    orgId: string;
    driverId: string;
    movementId: string;
    movementNumber: string;
    actorUserId: string | null;
  },
) {
  const [driver] = await tx
    .select({ userId: drivers.userId })
    .from(drivers)
    .where(and(eq(drivers.id, input.driverId), eq(drivers.organizationId, input.orgId)))
    .limit(1);
  if (!driver?.userId || driver.userId === input.actorUserId) {
    return { notified: 0, emailed: 0, pushed: 0 };
  }

  return notifyUser(db, {
    orgId: input.orgId,
    userId: driver.userId,
    eventType: "movement.assigned",
    title: `You are on ${input.movementNumber}`,
    body: "A dispatcher assigned this load to you.",
    linkPath: `/movements/${input.movementId}`,
  });
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------

async function deliverEmail(tx: RlsTransaction, input: NotifyInput, to: string) {
  const started = Date.now();
  const result = await sendEmail({
    to,
    subject: input.title,
    text: [input.body, input.linkPath ? `\n${input.linkPath}` : ""].filter(Boolean).join("\n"),
  });
  await logIntegrationEvent(tx, {
    orgId: input.orgId,
    provider: "email",
    direction: "outbound",
    operation: `notify:${input.eventType}`,
    request: { to, subject: input.title },
    response: { id: result.id, mode: result.mode },
    success: !result.error,
    error: result.error,
    durationMs: Date.now() - started,
  });
}

/**
 * Open a service-role transaction for the push step. The caller's transaction
 * cannot be reused: it runs as `authenticated`, and `push_tokens_for` is
 * EXECUTE-granted to `service_role` only so one member can never read another
 * member's handset tokens. The consequence is that the push (and its
 * integration_events row) commits independently of the caller's transaction —
 * acceptable, because an HTTP send cannot be rolled back either way.
 */
async function deliverPush(db: DatabaseClient | undefined, input: NotifyInput, userIds: string[]) {
  if (userIds.length === 0) return 0;
  const client = db ?? getDb();
  return withServiceRole(client, (tx) => deliverPushInTx(tx, input, userIds));
}

/** The push body itself, on a transaction that already holds the service role. */
async function deliverPushInTx(tx: RlsTransaction, input: NotifyInput, userIds: string[]) {
  const idList = sql.join(
    userIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const devices = await tx.execute<PushTokenRow>(sql`
    select * from public.push_tokens_for(${input.orgId}::uuid, array[${idList}])
  `);
  if (devices.length === 0) return 0;

  const messages: ExpoPushMessage[] = devices.map((d) => ({
    to: d.expo_push_token,
    title: input.title,
    body: input.body ?? "",
    data: { eventType: input.eventType, linkPath: input.linkPath ?? null },
  }));

  const started = Date.now();
  const result = await sendExpoPush(messages);
  await logIntegrationEvent(tx, {
    orgId: input.orgId,
    provider: "expo_push",
    direction: "outbound",
    operation: `notify:${input.eventType}`,
    request: { recipients: userIds.length, devices: devices.length, title: input.title },
    response: { mode: result.mode, sent: result.sent },
    success: !result.error,
    error: result.error,
    durationMs: Date.now() - started,
  });
  return devices.length;
}
