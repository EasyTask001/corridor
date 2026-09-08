import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { shipmentStatus, type ShipmentStatus } from "@corridor/domain";
import { buttonVariants } from "@corridor/ui";
import { getSession } from "@/lib/session";
import { ShipmentsList } from "./shipments-list";

export const metadata: Metadata = { title: "Shipments" };

const STATUS_ORDER: ShipmentStatus[] = [
  "draft",
  "sent",
  "accepted",
  "entry_on_file",
  "held",
  "released",
  "rejected",
  "arrived",
  "cancelled",
];

export default async function ShipmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; regime?: string; q?: string; unassigned?: string }>;
}) {
  const session = await getSession();
  if (!session?.permissions.has("shipment.read")) redirect("/dashboard");

  const sp = await searchParams;
  const status = shipmentStatus.safeParse(sp.status).success
    ? (sp.status as ShipmentStatus)
    : undefined;
  const regime = sp.regime === "ACE" || sp.regime === "ACI" ? sp.regime : undefined;
  const q = sp.q?.trim() || undefined;
  const unassignedOnly = sp.unassigned === "1";

  const canWrite = session.permissions.has("shipment.write");

  const href = (patch: Partial<Record<"status" | "regime" | "q" | "unassigned", string>>) => {
    const p = new URLSearchParams();
    const next = {
      status: sp.status,
      regime: sp.regime,
      q: sp.q,
      unassigned: sp.unassigned,
      ...patch,
    };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/shipments?${s}` : "/shipments";
  };
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs capitalize ${active ? "border-ink-950 bg-ink-950 text-white" : "border-ink-100 bg-white text-ink-700 hover:bg-ink-50"}`;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Shipments</h1>
          <p className="text-sm text-ink-500">
            Every customs filing, whether or not it is on a truck yet. Add one from a movement&apos;s
            Shipments step, or import a file.
          </p>
        </div>
        <Link href="/shipments/import" className={buttonVariants({ variant: "secondary" })}>
          Import CSV
        </Link>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Link href={href({ status: undefined })} className={chip(!status)}>
          All
        </Link>
        {STATUS_ORDER.map((s) => (
          <Link key={s} href={href({ status: s })} className={chip(status === s)}>
            {s.replace(/_/g, " ")}
          </Link>
        ))}
        <span className="mx-2 h-4 w-px bg-ink-100" />
        {(["ACE", "ACI"] as const).map((r) => (
          <Link
            key={r}
            href={href({ regime: regime === r ? undefined : r })}
            className={`${chip(regime === r)} font-mono`}
          >
            {r}
          </Link>
        ))}
        <Link
          href={href({ unassigned: unassignedOnly ? undefined : "1" })}
          className={chip(unassignedOnly)}
        >
          Unassigned only
        </Link>
      </div>

      <ShipmentsList
        status={status}
        regime={regime}
        unassignedOnly={unassignedOnly}
        initialSearch={q}
        canWrite={canWrite}
      />
    </div>
  );
}
