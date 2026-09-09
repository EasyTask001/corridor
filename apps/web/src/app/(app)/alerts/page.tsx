import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { AlertsList } from "./alerts-list";

export const metadata: Metadata = { title: "Alerts" };

export default async function AlertsPage() {
  const session = await getSession();
  if (!session?.permissions.has("alert.read")) redirect("/dashboard");

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Compliance alerts</h1>
        <p className="text-sm text-fg-secondary">
          Rule-based checks on driver, truck and trailer documents. Alerts resolve automatically
          when the underlying document is renewed.
        </p>
      </header>
      <AlertsList canManage={session.permissions.has("alert.manage")} />
    </div>
  );
}
