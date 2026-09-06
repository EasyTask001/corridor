import type { Metadata } from "next";
import Link from "next/link";
import { api } from "@/lib/trpc/server";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const [session, caller] = await Promise.all([getSession(), api()]);
  const can = (p: Parameters<NonNullable<typeof session>["permissions"]["has"]>[0]) =>
    session?.permissions.has(p) ?? false;

  const [me, org, alerts, drivers, trucks, trailers, partners] = await Promise.all([
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
  ]);

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
        <p className="text-sm text-ink-500">
          Signed in as {me.user.displayName ?? me.user.email} ·{" "}
          {me.memberships.find((m) => m.organizationId === me.activeOrganizationId)?.roleName}
        </p>
      </header>

      {alerts && (
        <Link
          href="/alerts"
          className={`panel flex items-center justify-between p-5 transition-colors hover:bg-ink-50 ${
            alerts.critical > 0 ? "border-danger-500/40" : ""
          }`}
        >
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-500">
              Compliance alerts
            </div>
            <div className="mt-1 text-2xl font-semibold">
              {alerts.total === 0 ? "All clear" : `${alerts.total} open`}
            </div>
          </div>
          <div className="flex gap-6 text-sm">
            <Stat label="Critical" value={alerts.critical} tone="danger" />
            <Stat label="Warning" value={alerts.warning} tone="warn" />
            <Stat label="Info" value={alerts.info} />
          </div>
        </Link>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {registries.map((r) => (
          <Link key={r.href} href={r.href} className="panel p-4 transition-colors hover:bg-ink-50">
            <div className="text-xs font-medium uppercase tracking-wide text-ink-500">
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
            <div className="text-xs font-medium uppercase tracking-wide text-ink-500">
              {s.label}
            </div>
            <div className="mt-1 font-mono text-lg">{s.value}</div>
          </div>
        ))}
      </section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warn" }) {
  const cls =
    tone === "danger" && value > 0
      ? "text-danger-500"
      : tone === "warn" && value > 0
        ? "text-warn-500"
        : "text-ink-500";
  return (
    <div className="text-right">
      <div className={`text-xl font-semibold ${cls}`}>{value}</div>
      <div className="text-xs text-ink-500">{label}</div>
    </div>
  );
}
