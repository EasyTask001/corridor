import type { Metadata } from "next";
import { api } from "@/lib/trpc/server";
import { NotificationRulesPanel } from "./notification-rules-panel";

export const metadata: Metadata = { title: "Notification settings" };

export default async function NotificationSettingsPage() {
  const caller = await api();
  const rules = await caller.notifications.rules.list();
  return (
    <div className="max-w-2xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="text-sm text-fg-secondary">
          Choose what you get notified about and how. In-app notifications always appear in your
          bell; email is opt-in per event.
        </p>
      </header>
      <NotificationRulesPanel initial={rules} />
    </div>
  );
}
