import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_EVENT_TYPES,
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
