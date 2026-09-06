import type { Metadata } from "next";
import { api } from "@/lib/trpc/server";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const caller = await api();
  const [me, org] = await Promise.all([caller.organization.me(), caller.organization.get()]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
        <p className="text-sm text-ink-500">
          Signed in as {me.user.displayName ?? me.user.email} ·{" "}
          {me.memberships.find((m) => m.organizationId === me.activeOrganizationId)?.roleName}
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "SCAC", value: org.scacCode ?? "—" },
          { label: "CBSA carrier code", value: org.canadianCarrierCode ?? "—" },
          { label: "USDOT", value: org.usDotNumber ?? "—" },
          { label: "Plan", value: `${org.subscriptionPlan} · ${org.subscriptionStatus}` },
        ].map((s) => (
          <div key={s.label} className="panel p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-ink-500">
              {s.label}
            </div>
            <div className="mt-1 font-mono text-lg">{s.value}</div>
          </div>
        ))}
      </section>

      <section className="panel p-6">
        <h2 className="font-medium">Foundations ready</h2>
        <p className="mt-1 text-sm text-ink-500">
          Movements, registries, documents and alerts arrive in the next phases. Your permissions in
          this organization:
        </p>
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {me.permissions.map((p) => (
            <li key={p} className="rounded bg-ink-100 px-2 py-0.5 font-mono text-xs text-ink-700">
              {p}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
