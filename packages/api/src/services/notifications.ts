/**
 * Fan-out notifications to every org member holding the permission an event
 * type requires (see NOTIFICATION_EVENT_TYPES), respecting each member's own
 * opt-out/channel preference. Insertion happens inside `notify_organization`
 * (SECURITY DEFINER), so this works identically from a user's RLS transaction
 * or a service-role background job — callers never target another user's row
 * directly.
 */
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType } from "@corridor/domain";
import { sendEmail } from "@corridor/integrations";
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

/**
 * Creates the notification rows and, for recipients whose channel includes
 * 'email', sends (or mock-sends) the email — logged as an integration_event
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

  return { notified: rows.length, emailed: emailTargets.length };
}
