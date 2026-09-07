import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { IntegrationsPanel } from "./integrations-panel";

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage() {
  const session = await getSession();
  if (!session?.permissions.has("integrations.manage")) redirect("/dashboard");
  const caller = await api();
  const [configs, events, jobs, stats] = await Promise.all([
    caller.integrations.configs.list(),
    caller.integrations.events.list({ limit: 50 }),
    caller.integrations.jobs.list({ limit: 30 }),
    caller.integrations.jobs.stats(),
  ]);
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-ink-500">
          Customs gateways, reference data and billing. Gateway credentials are encrypted into
          Supabase Vault on save: the fields below are write-only, the stored values are never
          returned to this page, and only the server reads them — at transmit time, in production.
        </p>
      </header>
      <IntegrationsPanel
        initialConfigs={configs}
        initialEvents={events}
        initialJobs={jobs}
        initialStats={stats}
      />
    </div>
  );
}
