import type { Metadata } from "next";
import { api } from "@/lib/trpc/server";
import { NotificationsList } from "./notifications-list";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const caller = await api();
  const initial = await caller.notifications.list({ limit: 50, offset: 0, unreadOnly: false });
  return (
    <div className="max-w-2xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="text-sm text-ink-500">
          Critical compliance alerts, customs decisions and documents needing review. Manage what
          you get notified about in{" "}
          <a href="/settings/notifications" className="underline">
            Settings
          </a>
          .
        </p>
      </header>
      <NotificationsList initial={initial} />
    </div>
  );
}
