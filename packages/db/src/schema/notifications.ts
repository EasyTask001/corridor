import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { DevicePlatform, NotificationChannel, NotificationEventType } from "@corridor/domain";
import { authUsers, organizations } from "./core";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    type: text("type").$type<NotificationEventType>().notNull(),
    title: text("title").notNull(),
    body: text("body"),
    linkPath: text("link_path"),
    channel: text("channel")
      .array()
      .$type<NotificationChannel[]>()
      .notNull()
      .default(sql`array['in_app']`),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("notifications_user_unread_idx")
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
    // 0011
    index("notifications_org_created_idx").on(t.organizationId, t.createdAt.desc()),
  ],
);

export const notificationRules = pgTable(
  "notification_rules",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    /** Rule *selector* — which notification type this preference applies to. */
    eventType: text("event_type").$type<NotificationEventType>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    channel: text("channel")
      .array()
      .$type<NotificationChannel[]>()
      .notNull()
      .default(sql`array['in_app']`),
    /** Optional narrowing predicate, e.g. `{ "regime": "ACE" }`. */
    filters: jsonb("filters").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("notification_rules_organization_id_user_id_event_type_key").on(
      t.organizationId,
      t.userId,
      t.eventType,
    ),
  ],
);

/**
 * Expo push registrations for the driver app (migration 0015). One row per
 * (user, token); a user may carry more than one handset.
 */
export const userDevices = pgTable(
  "user_devices",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    expoPushToken: text("expo_push_token").notNull(),
    platform: text("platform").$type<DevicePlatform>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("user_devices_user_id_expo_push_token_key").on(t.userId, t.expoPushToken),
    index("user_devices_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("user_devices_org_idx").on(t.organizationId),
  ],
);
