/**
 * Fan-out notifications to every org member holding the permission an event
 * type requires (see NOTIFICATION_EVENT_TYPES), respecting each member's own
 * opt-out/channel preference. Insertion happens inside `notify_organization`
 * (SECURITY DEFINER), so this works identically from a user's RLS transaction
 * or a service-role background job — callers never target another user's row
 * directly.
 */
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType } from "@corridor/domain";
import { sendEmail, sendExpoPush, type ExpoPushMessage } from "@corridor/integrations";
import { sql, type RlsTransaction } from "@corridor/db";
import { logIntegrationEvent } from "./customs";

export interface NotifyInput {
  orgId: string;
  eventType: NotificationEventType;
  title: string;
  body?: string;
  linkPath?: string;
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
    const started = Date.now();
    const result = await sendEmail({
      to: r.email,
      subject: input.title,
      text: [input.body, input.linkPath ? `\n${input.linkPath}` : ""].filter(Boolean).join("\n"),
    });
    await logIntegrationEvent(tx, {
      orgId: input.orgId,
      provider: "email",
      direction: "outbound",
      operation: `notify:${input.eventType}`,
      request: { to: r.email, subject: input.title },
      response: { id: result.id, mode: result.mode },
      success: !result.error,
      error: result.error,
      durationMs: Date.now() - started,
    });
  }

  const pushed = await sendPush(tx, input, rows);

  return { notified: rows.length, emailed: emailTargets.length, pushed };
}

/**
 * Push counterpart of the email loop. `push_tokens_for` (migration 0015) is
 * SECURITY DEFINER for the same reason `notify_organization` is: the fan-out
 * runs inside the acting user's RLS transaction and `user_devices` is
 * user-scoped, so the recipients' tokens are unreachable by a direct select.
 * One handset can be registered per row, so a recipient with three devices
 * gets three messages.
 */
async function sendPush(tx: RlsTransaction, input: NotifyInput, rows: NotifiedRow[]) {
  const recipients = rows.filter((r) => r.channel?.includes("push")).map((r) => r.user_id);
  if (recipients.length === 0) return 0;

  const idList = sql.join(
    recipients.map((id) => sql`${id}::uuid`),
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
    request: { recipients: recipients.length, devices: devices.length, title: input.title },
    response: { mode: result.mode, sent: result.sent },
    success: !result.error,
    error: result.error,
    durationMs: Date.now() - started,
  });
  return devices.length;
}
