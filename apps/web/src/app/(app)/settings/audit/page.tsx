import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { AuditList } from "./audit-list";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage() {
  const session = await getSession();
  if (!session?.permissions.has("audit_log.read")) redirect("/dashboard");
  const caller = await api();
  const initial = await caller.audit.list({ limit: 100 });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-fg-secondary">
          An append-only record of sensitive organization and operational changes.
        </p>
      </header>
      <AuditList initial={initial} />
    </div>
  );
}
