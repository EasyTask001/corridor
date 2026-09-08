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
 * ## Why push is never sent inline
 *
 * `push_tokens_for` is EXECUTE-granted to `service_role` only (migration 0015),
 * because a push token is a bearer capability. Reaching it therefore needs a
 * service-role transaction — and taking one *while the caller's RLS transaction
 * is still open* would hold two connections from the same pool per request,
 * which self-deadlocks under load (see the warning on `withServiceRole`).
 *
 * So neither path ever nests:
 *
 *  - `notifyOrganization` runs inside the caller's transaction and merely
 *    **enqueues** a `notification.push` job with the ids of the rows it just
 *    created. The worker delivers them under its own service role. The job
 *    commits with the caller, so a rolled-back mutation pushes nothing.
 *  - `notifyUser` opens the only transaction in play, and callers MUST invoke it
 *    *after* their own transaction has resolved (see `movement.update`).
 */
import {
  NOTIFICATION_EVENT_TYPES,
  defaultChannelFor,
  type NotificationChannel,
  type NotificationEventType,
} from "@corridor/domain";
import {
  deadPushTokens,
  sendEmail,
  sendExpoPush,
  sendSms,
  type ExpoPushMessage,
} from "@corridor/integrations";
import {
  and,
  eq,
  inArray,
  schema,
  sql,
  withServiceRole,
  type DatabaseClient,
  type RlsTransaction,
} from "@corridor/db";
import { logIntegrationEvent } from "./customs";
import { enqueueJob } from "./jobs";

const { authUsers, drivers, notificationRules, notifications, userDevices, userProfiles } = schema;

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
export async function notifyOrganization(tx: RlsTransaction, input: NotifyInput) {
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

  // SMS (0025) goes to the member's profile phone; no phone, nothing sent.
  const smsTargets = rows.filter((r) => r.channel?.includes("sms"));
  let smsSent = 0;
  if (smsTargets.length > 0) {
    const phones = await tx
      .select({ userId: userProfiles.userId, phone: userProfiles.phone })
      .from(userProfiles)
      .where(
        inArray(
          userProfiles.userId,
          smsTargets.map((r) => r.user_id),
        ),
      );
    const phoneOf = new Map(phones.map((p) => [p.userId, p.phone]));
    for (const r of smsTargets) {
      const phone = phoneOf.get(r.user_id);
      if (!phone) continue;
      await deliverSms(tx, input, phone);
      smsSent += 1;
    }
  }

  // Push is handed to the worker rather than sent here: it needs the service
  // role, and this code runs inside the caller's RLS transaction.
  const pushTargets = rows.filter((r) => r.channel?.includes("push"));
  if (pushTargets.length > 0) {
    await enqueueJob(tx, {
      orgId: input.orgId,
      jobType: "notification.push",
      // Only the row ids travel: the worker re-reads title, body and recipient
      // from `notifications`, so a forged job cannot push arbitrary text.
      payload: { notificationIds: pushTargets.map((r) => r.notification_id) },
      maxAttempts: 2,
    });
  }

  return {
    notified: rows.length,
    emailed: emailTargets.length,
    queuedPush: pushTargets.length,
    smsSent,
  };
}

/**
 * Deliver a targeted event to one member. Returns `{ notified: 0 }` when the
 * recipient turned the event off; an unknown user id simply produces nothing.
 *
 * Everything runs under the service role, so:
 *  - callers MUST have established that `userId` belongs to `orgId` — every
 *    caller here resolves the recipient from an org-scoped row it already read
 *    under RLS; and
 *  - callers MUST NOT be inside their own transaction when they call it, or the
 *    request holds two pooled connections at once.
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

    const pushed = channel.includes("push") ? await deliverPushInTx(tx, input) : 0;

    if (channel.includes("sms")) {
      const [profile] = await tx
        .select({ phone: userProfiles.phone })
        .from(userProfiles)
        .where(eq(userProfiles.userId, input.userId))
        .limit(1);
      if (profile?.phone) await deliverSms(tx, input, profile.phone);
    }

    return { notified: 1, emailed, pushed };
  });
}

/**
 * `movement.assigned`, phase 1 — decide, inside the caller's transaction,
 * whether a notification is owed and to whom. Reads `drivers` under the
 * caller's RLS, so it can only ever resolve a driver they can already see.
 *
 * Returns `null` when the driver record has no linked auth user (a paper-only
 * driver) or when the driver *is* the acting user — nobody needs a notification
 * about their own edit.
 *
 * Phase 2 is `notifyUser`, which the caller runs once its transaction has
 * committed. Splitting the two is what keeps a service-role connection from
 * being taken while an RLS transaction is open.
 */
export async function resolveDriverAssignment(
  tx: RlsTransaction,
  input: {
    orgId: string;
    driverId: string;
    movementId: string;
    movementNumber: string;
    actorUserId: string | null;
  },
): Promise<NotifyUserInput | null> {
  const [driver] = await tx
    .select({ userId: drivers.userId })
    .from(drivers)
    .where(and(eq(drivers.id, input.driverId), eq(drivers.organizationId, input.orgId)))
    .limit(1);
  if (!driver?.userId || driver.userId === input.actorUserId) return null;

  return {
    orgId: input.orgId,
    userId: driver.userId,
    eventType: "movement.assigned",
    title: `You are on ${input.movementNumber}`,
    body: "A dispatcher assigned this load to you.",
    linkPath: `/movements/${input.movementId}`,
  };
}

/**
 * Worker body for the `notification.push` job. Re-reads the rows the fan-out
 * created — the job payload carries nothing but their ids — so the message text
 * and the recipient always come from the database, never from the job.
 *
 * Already running under the service role (the worker's own transaction), which
 * is what makes `push_tokens_for` reachable.
 */
export async function deliverQueuedPush(
  tx: RlsTransaction,
  orgId: string,
  notificationIds: string[],
) {
  if (notificationIds.length === 0) return { pushed: 0, devices: 0 };

  const rows = await tx
    .select({
      userId: notifications.userId,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      linkPath: notifications.linkPath,
      channel: notifications.channel,
    })
    .from(notifications)
    .where(
      and(eq(notifications.organizationId, orgId), inArray(notifications.id, notificationIds)),
    );

  const targets = rows.filter((r) => r.channel?.includes("push"));
  if (targets.length === 0) return { pushed: 0, devices: 0 };

  const tokensByUser = await pushTokensByUser(tx, orgId, [
    ...new Set(targets.map((r) => r.userId)),
  ]);
  const messages: ExpoPushMessage[] = targets.flatMap((row) =>
    (tokensByUser.get(row.userId) ?? []).map((to) => ({
      to,
      title: row.title,
      body: row.body ?? "",
      data: { eventType: row.type, linkPath: row.linkPath },
    })),
  );
  if (messages.length === 0) return { pushed: 0, devices: 0 };

  const eventType = targets[0]!.type;
  const started = Date.now();
  const result = await sendExpoPush(messages);
  // Expo asks senders to stop using a token it reports as DeviceNotRegistered
  // (app uninstalled, or the registration expired). Nothing else ever prunes
  // user_devices, so a dead handset would otherwise be re-sent to on every
  // fan-out forever. We already hold the service role here.
  const pruned = await pruneDeadDevices(tx, orgId, deadPushTokens(messages, result.tickets));
  await logIntegrationEvent(tx, {
    orgId,
    provider: "expo_push",
    direction: "outbound",
    operation: `notify:${eventType}`,
    request: { notifications: targets.length, devices: messages.length },
    response: { mode: result.mode, sent: result.sent, prunedDevices: pruned },
    success: !result.error,
    error: result.error,
    durationMs: Date.now() - started,
  });
  return { pushed: result.sent, devices: messages.length, prunedDevices: pruned };
}

/** Delete the `user_devices` rows for tokens Expo has retired. Returns the count. */
async function pruneDeadDevices(
  tx: RlsTransaction,
  orgId: string,
  tokens: string[],
): Promise<number> {
  if (tokens.length === 0) return 0;
  const deleted = await tx
    .delete(userDevices)
    .where(and(eq(userDevices.organizationId, orgId), inArray(userDevices.expoPushToken, tokens)))
    .returning({ id: userDevices.id });
  return deleted.length;
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------

async function deliverSms(tx: RlsTransaction, input: NotifyInput, to: string) {
  const started = Date.now();
  const result = await sendSms({
    to,
    body: [input.title, input.body].filter(Boolean).join(" — ").slice(0, 640),
  });
  await logIntegrationEvent(tx, {
    orgId: input.orgId,
    provider: "sms",
    direction: "outbound",
    operation: `notify:${input.eventType}`,
    request: { to, title: input.title },
    response: { id: result.id, mode: result.mode },
    success: !result.error,
    error: result.error,
    durationMs: Date.now() - started,
  });
}

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
 * Recipient → their registered Expo tokens, via the `service_role`-only
 * `push_tokens_for`. The transaction handed in must already hold the service
 * role: either the worker's, or `notifyUser`'s own — never one nested inside a
 * caller's RLS transaction.
 */
async function pushTokensByUser(
  tx: RlsTransaction,
  orgId: string,
  userIds: string[],
): Promise<Map<string, string[]>> {
  const byUser = new Map<string, string[]>();
  if (userIds.length === 0) return byUser;
  const idList = sql.join(
    userIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const devices = await tx.execute<PushTokenRow>(sql`
    select * from public.push_tokens_for(${orgId}::uuid, array[${idList}])
  `);
  for (const device of devices) {
    byUser.set(device.user_id, [...(byUser.get(device.user_id) ?? []), device.expo_push_token]);
  }
  return byUser;
}

/** The push body for a single targeted event, on a service-role transaction. */
async function deliverPushInTx(tx: RlsTransaction, input: NotifyUserInput) {
  const tokens = (await pushTokensByUser(tx, input.orgId, [input.userId])).get(input.userId) ?? [];
  if (tokens.length === 0) return 0;

  const messages: ExpoPushMessage[] = tokens.map((to) => ({
    to,
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
    request: { recipients: 1, devices: messages.length, title: input.title },
    response: { mode: result.mode, sent: result.sent },
    success: !result.error,
    error: result.error,
    durationMs: Date.now() - started,
  });
  return messages.length;
}
