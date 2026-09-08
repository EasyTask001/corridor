import { z } from "zod";
import { isoDateTime, uuid } from "./common";

/**
 * Every event type Corridor can notify about, the permission a member must hold
 * to receive it (mirrors `notify_organization`'s required permission argument,
 * kept here as the single source of truth) and the channels it uses until the
 * member overrides them in Settings → Notifications.
 *
 * `targeted: true` marks an event that is delivered to one specific recipient
 * rather than fanned out to everyone holding the permission — the permission
 * then only says who is *allowed* to receive it.
 */
export const NOTIFICATION_EVENT_TYPES = {
  "alert.critical": {
    label: "Critical compliance alert",
    description: "A document expiry or risk finding was raised at critical severity.",
    permission: "alert.manage",
    defaultChannel: ["in_app"],
    targeted: false,
  },
  "customs.decision": {
    label: "Customs decision",
    description: "CBP/CBSA accepted, rejected, released or held a manifest.",
    permission: "movement.transmit_to_customs",
    defaultChannel: ["in_app"],
    targeted: false,
  },
  "customs.notice": {
    label: "Customs service notice",
    description: "CBP or CBSA published a service notice (outage, cut-over, port closure).",
    permission: "movement.read",
    defaultChannel: ["in_app"],
    targeted: false,
  },
  "document.review_needed": {
    label: "Document needs review",
    description: "AI extraction finished with low confidence and needs a human check.",
    permission: "document.review_extraction",
    defaultChannel: ["in_app"],
    targeted: false,
  },
  "movement.assigned": {
    label: "Load assigned to you",
    description: "A dispatcher put you on a movement — delivered to that driver only.",
    permission: "movement.read_assigned",
    // The driver app is the point of this event, so push is on by default.
    defaultChannel: ["in_app", "push"],
    targeted: true,
  },
} as const;

export type NotificationEventType = keyof typeof NOTIFICATION_EVENT_TYPES;
export const notificationEventType = z.enum(
  Object.keys(NOTIFICATION_EVENT_TYPES) as [NotificationEventType, ...NotificationEventType[]],
);

/**
 * Delivery channels. `push` reaches the Expo driver app through the devices a
 * user registered with `notifications.registerDevice` — a member with no
 * registered device simply receives nothing on that channel.
 */
export const notificationChannel = z.enum(["in_app", "email", "push"]);
export type NotificationChannel = z.infer<typeof notificationChannel>;

/** The channels an event type uses when the member has no rule row of their own. */
export function defaultChannelFor(eventType: NotificationEventType): NotificationChannel[] {
  return [...NOTIFICATION_EVENT_TYPES[eventType].defaultChannel];
}

export const notificationSchema = z.object({
  id: uuid,
  organizationId: uuid,
  /** Matches the `notifications.type` column (the rule selector is `notification_rules.event_type`). */
  type: notificationEventType,
  title: z.string(),
  body: z.string().nullable(),
  linkPath: z.string().nullable(),
  channel: z.array(notificationChannel),
  readAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListInput = z.object({
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).default(0),
});

export const notificationRuleInput = z.object({
  eventType: notificationEventType,
  enabled: z.boolean().default(true),
  channel: z.array(notificationChannel).min(1).default(["in_app"]),
  /** Optional narrowing predicate stored on the rule, e.g. `{ regime: "ACE" }`. */
  filters: z.record(z.string(), z.unknown()).default({}),
});
export type NotificationRuleInput = z.infer<typeof notificationRuleInput>;

export const notificationRuleSchema = notificationRuleInput.extend({
  id: uuid,
});
export type NotificationRule = z.infer<typeof notificationRuleSchema>;

// ---------------------------------------------------------------------------
// Push devices (Expo driver app)
// ---------------------------------------------------------------------------

export const devicePlatform = z.enum(["ios", "android"]);
export type DevicePlatform = z.infer<typeof devicePlatform>;

/**
 * Expo hands out tokens shaped `ExponentPushToken[xxxxxxxx]`. Validating the
 * shape here keeps junk out of `user_devices` and out of the fan-out's HTTP
 * body — Expo rejects the whole batch when one recipient is malformed.
 */
export const expoPushToken = z
  .string()
  .trim()
  .regex(/^Expo(nent)?PushToken\[[^\]\s]+\]$/, "Expected an Expo push token");

export const registerDeviceInput = z.object({
  expoPushToken,
  platform: devicePlatform,
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceInput>;

/** `notifications.markRead` — shared so the mobile offline outbox validates the same shape. */
export const notificationMarkReadInput = z.object({ id: uuid });
export type NotificationMarkReadInput = z.infer<typeof notificationMarkReadInput>;

export const userDeviceSchema = z.object({
  id: uuid,
  userId: uuid,
  organizationId: uuid,
  expoPushToken,
  platform: devicePlatform,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type UserDevice = z.infer<typeof userDeviceSchema>;
