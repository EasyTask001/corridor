import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { ExternalShipments } from "./external-shipments";
import { InBondMonitor } from "./in-bond-monitor";

export const metadata: Metadata = { title: "In-bond" };

export default async function InBondPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await getSession();
  if (!session?.permissions.has("inbond.read")) redirect("/dashboard");
  const canWrite = session.permissions.has("inbond.write");
  const tab = (await searchParams).tab === "external" ? "external" : "monitor";

  const caller = await api();
  const [records, external, shipments, aceCapabilities, aciCapabilities] = await Promise.all([
    caller.inbond.records.list({ limit: 100, offset: 0 }),
    caller.inbond.external.list({ limit: 100, offset: 0 }),
    // In-bond shipments of ours that have no record yet can be put on the monitor.
    caller.shipment.list({ limit: 200, offset: 0 }),
    caller.integrations.customsCapabilities({ regime: "ACE" }),
    caller.integrations.customsCapabilities({ regime: "ACI" }),
  ]);

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${active ? "border-accent bg-accent text-accent-fg" : "border-border-default bg-surface-raised text-fg-primary hover:bg-surface-sunken"}`;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">In-bond</h1>
        <p className="text-sm text-fg-secondary">
          Bonded moves (IT / TE / IE) from arrival to export, for our shipments and for goods
          another carrier filed.
        </p>
      </header>
      <nav className="flex gap-2" aria-label="In-bond tabs">
        <Link href="/in-bond" className={chip(tab === "monitor")}>
          Monitor <span className="ml-1 font-mono opacity-70">{records.total}</span>
        </Link>
        <Link href="/in-bond?tab=external" className={chip(tab === "external")}>
          External shipments <span className="ml-1 font-mono opacity-70">{external.total}</span>
        </Link>
      </nav>
      {tab === "monitor" ? (
        <InBondMonitor
          initial={records}
          canWrite={canWrite}
          capabilities={{ ACE: aceCapabilities, ACI: aciCapabilities }}
          inBondShipments={shipments.rows
            .filter((s) => s.shipmentType === "in_bond")
            .map((s) => ({ id: s.id, label: s.controlNumber, regime: s.regime }))}
          externalShipments={external.rows
            .filter((x) => x.status === "open" && !x.recordId)
            .map((x) => ({
              id: x.id,
              label: x.controlNumber ?? x.inBondNumber ?? "",
              regime: x.regime,
            }))}
        />
      ) : (
        <ExternalShipments initial={external} canWrite={canWrite} />
      )}
    </div>
  );
}
