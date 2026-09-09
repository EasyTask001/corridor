import type { Metadata } from "next";
import Link from "next/link";
import { api } from "@/lib/trpc/server";
import { getSession } from "@/lib/session";
import { MonthlyChart } from "./monthly-chart";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const [session, caller] = await Promise.all([getSession(), api()]);
  const can = (p: Parameters<NonNullable<typeof session>["permissions"]["has"]>[0]) =>
    session?.permissions.has(p) ?? false;

  const [me, org, alerts, drivers, trucks, trailers, partners, stats] = await Promise.all([
    caller.organization.me(),
    caller.organization.get(),
    can("alert.read") ? caller.alerts.summary() : null,
    can("driver.read")
      ? caller.party.drivers.list({ limit: 1, offset: 0, includeArchived: false })
      : null,
    can("truck.read")
      ? caller.party.trucks.list({ limit: 1, offset: 0, includeArchived: false })
      : null,
    can("trailer.read")
      ? caller.party.trailers.list({ limit: 1, offset: 0, includeArchived: false })
      : null,
    can("partner.read")
      ? caller.party.partners.list({ limit: 1, offset: 0, includeArchived: false })
      : null,
    can("movement.read") ? caller.reporting.dashboard() : null,
  ]);
  const monthLabel = new Date().toLocaleString("en-CA", { month: "long", year: "numeric" });

  const registries = [
    { label: "Drivers", href: "/parties/drivers", total: drivers?.total },
    { label: "Trucks", href: "/parties/trucks", total: trucks?.total },
    { label: "Trailers", href: "/parties/trailers", total: trailers?.total },
    { label: "Partners", href: "/parties/partners", total: partners?.total },
  ].filter((r) => r.total !== undefined);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
        <p className="text-sm text-fg-secondary">
          Signed in as {me.user.displayName ?? me.user.email} ·{" "}
          {me.memberships.find((m) => m.organizationId === me.activeOrganizationId)?.roleName}
        </p>
      </header>

      {alerts && (
        <Link
          href="/alerts"
          className={`panel flex flex-col items-start justify-between gap-4 p-5 transition-colors hover:bg-surface-sunken sm:flex-row sm:items-center ${
            alerts.critical > 0 ? "border-danger-500/40" : ""
          }`}
        >
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-fg-secondary">
              Compliance alerts
            </div>
            <div className="mt-1 text-2xl font-semibold">
              {alerts.total === 0 ? "All clear" : `${alerts.total} open`}
            </div>
          </div>
          <div className="flex w-full justify-between gap-6 text-sm sm:w-auto">
            <Stat label="Critical" value={alerts.critical} tone="danger" />
            <Stat label="Warning" value={alerts.warning} tone="warn" />
            <Stat label="Info" value={alerts.info} />
          </div>
        </Link>
      )}

      {stats && (
        <section className="grid gap-4 lg:grid-cols-[1fr_2fr]" aria-label="Movements this month">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            {(["ACE", "ACI"] as const).map((regime) => (
              <Link
                key={regime}
                href={`/movements?regime=${regime}`}
                className="panel p-4 transition-colors hover:bg-surface-sunken"
              >
                <div className="text-xs font-medium uppercase tracking-wide text-fg-secondary">
                  {regime} this month
                </div>
                <div
                  className="mt-1 text-2xl font-semibold"
                  data-testid={`tile-${regime.toLowerCase()}`}
                >
                  {stats.thisMonth[regime]}
                </div>
                <div className="text-xs text-fg-secondary">
                  {regime === "ACE" ? "US-bound" : "Canada-bound"} manifests created in {monthLabel}
                </div>
              </Link>
            ))}
          </div>
          <MonthlyChart series={stats.series} />
        </section>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {registries.map((r) => (
          <Link
            key={r.href}
            href={r.href}
            className="panel p-4 transition-colors hover:bg-surface-sunken"
          >
            <div className="text-xs font-medium uppercase tracking-wide text-fg-secondary">
              {r.label}
            </div>
            <div className="mt-1 text-2xl font-semibold">{r.total}</div>
          </Link>
        ))}
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "SCAC", value: org.scacCode ?? "—" },
          { label: "CBSA carrier code", value: org.canadianCarrierCode ?? "—" },
          { label: "USDOT", value: org.usDotNumber ?? "—" },
          { label: "Plan", value: `${org.subscriptionPlan} · ${org.subscriptionStatus}` },
        ].map((s) => (
          <div key={s.label} className="panel p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-fg-secondary">
              {s.label}
            </div>
            <div className="mt-1 font-mono text-lg">{s.value}</div>
          </div>
        ))}
      </section>

      {stats && stats.recentShipments.length > 0 && (
        <section className="panel overflow-x-auto" aria-label="Recent shipments">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="font-medium">Recent shipments</h2>
            <Link href="/shipments" className="text-xs text-fg-secondary hover:underline">
              All shipments
            </Link>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-fg-secondary">
              <tr>
                <th className="px-3 py-2 font-medium">Control number</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Entry</th>
                <th className="px-3 py-2 font-medium">Movement</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default">
              {stats.recentShipments.map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/shipments/${s.id}`} className="hover:underline">
                      {s.controlNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2 capitalize">{s.status.replace(/_/g, " ")}</td>
                  <td className="px-3 py-2 font-mono text-xs">{s.entryNumber ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{s.movementNumber ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-fg-secondary">
                    {new Date(s.updatedAt).toLocaleString("en-CA", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warn" }) {
  const cls =
    tone === "danger" && value > 0
      ? "text-status-danger"
      : tone === "warn" && value > 0
        ? "text-status-warn"
        : "text-fg-secondary";
  return (
    <div className="text-right">
      <div className={`text-xl font-semibold ${cls}`}>{value}</div>
      <div className="text-xs text-fg-secondary">{label}</div>
    </div>
  );
}
