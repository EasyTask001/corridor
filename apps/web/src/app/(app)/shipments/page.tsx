import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { shipmentStatus, type ShipmentStatus } from "@corridor/domain";
import { Card, Input } from "@corridor/ui";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";

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

const kindOf = (s: { shipmentType: string | null; cargoType: string | null }) =>
  (s.shipmentType ?? s.cargoType ?? "—").replace(/_/g, " ");

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

  const caller = await api();
  const list = await caller.shipment.list({
    status: status ? [status] : undefined,
    regime,
    q,
    unassignedOnly: unassignedOnly || undefined,
    limit: 100,
    offset: 0,
  });

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
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Shipments</h1>
        <p className="text-sm text-ink-500">
          Every customs filing, whether or not it is on a truck yet. Add one from a movement&apos;s
          Shipments step.
        </p>
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
        <form className="ml-auto" method="get">
          {status && <input type="hidden" name="status" value={status} />}
          {regime && <input type="hidden" name="regime" value={regime} />}
          {unassignedOnly && <input type="hidden" name="unassigned" value="1" />}
          <Input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search control, entry or in-bond number…"
            aria-label="Search shipments"
            className="w-72"
          />
        </form>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-3 py-2 font-medium">Control number</th>
              <th className="px-3 py-2 font-medium">Regime</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Shipper</th>
              <th className="px-3 py-2 text-right font-medium">Lines</th>
              <th className="px-3 py-2 font-medium">Movement</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {list.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-ink-500">
                  No shipments match these filters.
                </td>
              </tr>
            )}
            {list.rows.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2 font-mono text-xs">
                  <Link href={`/shipments/${s.id}`} className="hover:underline">
                    {s.controlNumber}
                  </Link>
                  {s.isPars && (
                    <span className="ml-2 text-[10px] uppercase text-ink-500">PARS</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{s.regime}</td>
                <td className="px-3 py-2 capitalize">{kindOf(s)}</td>
                <td className="px-3 py-2">{s.shipperName ?? "—"}</td>
                <td className="px-3 py-2 text-right font-mono">{s.commodityCount}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  {s.movementId ? (
                    <Link href={`/movements/${s.movementId}`} className="hover:underline">
                      {s.movementNumber}
                    </Link>
                  ) : (
                    <span className="text-ink-500">unassigned</span>
                  )}
                </td>
                <td className="px-3 py-2 capitalize">{s.status.replace(/_/g, " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
