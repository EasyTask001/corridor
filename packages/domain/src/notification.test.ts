import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_EVENT_TYPES,
  defaultChannelFor,
  notificationChannel,
  notificationEventType,
  notificationRuleInput,
} from "./notification";

describe("notification event types", () => {
  it("every event type declares the permission gating who receives it", () => {
    for (const [key, def] of Object.entries(NOTIFICATION_EVENT_TYPES)) {
      expect(notificationEventType.safeParse(key).success).toBe(true);
      expect(def.permission.length).toBeGreaterThan(0);
    }
  });

  it("every event type declares at least one valid default channel", () => {
    for (const key of Object.keys(NOTIFICATION_EVENT_TYPES)) {
      const channels = defaultChannelFor(key as keyof typeof NOTIFICATION_EVENT_TYPES);
      expect(channels.length).toBeGreaterThan(0);
      for (const channel of channels) {
        expect(notificationChannel.safeParse(channel).success).toBe(true);
      }
    }
  });

  it("reaches drivers only through the targeted movement.assigned event", () => {
    const driverEvents = Object.entries(NOTIFICATION_EVENT_TYPES).filter(
      ([, def]) => def.permission === "movement.read_assigned",
    );
    expect(driverEvents.map(([key]) => key)).toEqual(["movement.assigned"]);
    // Delivered to one driver, not fanned out to everyone holding the permission.
    expect(NOTIFICATION_EVENT_TYPES["movement.assigned"].targeted).toBe(true);
    expect(defaultChannelFor("movement.assigned")).toEqual(["in_app", "push"]);
  });
});

describe("notificationRuleInput", () => {
  it("defaults to enabled + in_app", () => {
    const parsed = notificationRuleInput.parse({ eventType: "alert.critical" });
    expect(parsed).toMatchObject({ enabled: true, channel: ["in_app"] });
  });

  it("rejects an empty channel list", () => {
    expect(
      notificationRuleInput.safeParse({ eventType: "alert.critical", channel: [] }).success,
    ).toBe(false);
  });
});
