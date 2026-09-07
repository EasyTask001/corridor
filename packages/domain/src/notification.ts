import { z } from "zod";
import { isoDateTime, uuid } from "./common";

/**
 * Every event type Corridor can notify about, and the permission a member
 * must hold to receive it (mirrors `notify_organization`'s required
 * permission argument, kept here as the single source of truth).
 */
export const NOTIFICATION_EVENT_TYPES = {
  "alert.critical": {
    label: "Critical compliance alert",
    description: "A document expiry or risk finding was raised at critical severity.",
    permission: "alert.manage",
  },
  "customs.decision": {
    label: "Customs decision",
    description: "CBP/CBSA accepted, rejected, released or held a manifest.",
    permission: "movement.transmit_to_customs",
  },
  "document.review_needed": {
    label: "Document needs review",
    description: "AI extraction finished with low confidence and needs a human check.",
    permission: "document.review_extraction",
  },
} as const;

export type NotificationEventType = keyof typeof NOTIFICATION_EVENT_TYPES;
export const notificationEventType = z.enum(
  Object.keys(NOTIFICATION_EVENT_TYPES) as [NotificationEventType, ...NotificationEventType[]],
);

export const notificationChannel = z.enum(["in_app", "email"]);
export type NotificationChannel = z.infer<typeof notificationChannel>;

export const notificationSchema = z.object({
  id: uuid,
  organizationId: uuid,
  eventType: notificationEventType,
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
});
export type NotificationRuleInput = z.infer<typeof notificationRuleInput>;

export const notificationRuleSchema = notificationRuleInput.extend({
  id: uuid,
});
export type NotificationRule = z.infer<typeof notificationRuleSchema>;
