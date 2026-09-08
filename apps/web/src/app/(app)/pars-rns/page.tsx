import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, Input } from "@corridor/ui";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";

export const metadata: Metadata = { title: "PARS RNS" };

const RANGES = [1, 7, 30] as const;

export default async function ParsRnsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; range?: string }>;
}) {
  const session = await getSession();
  if (!session?.permissions.has("shipment.read")) redirect("/dashboard");
  const sp = await searchParams;
  const rangeDays = RANGES.includes(Number(sp.range) as (typeof RANGES)[number]) ? Number(sp.range) : 30;
  const q = sp.q?.trim() || undefined;

  const caller = await api();
  const feed = await caller.shipment.rns.list({ q, rangeDays, limit: 200, offset: 0 });
  const fmt = (d: Date | null) =>
    d ? d.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "—";
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${active ? "border-ink-950 bg-ink-950 text-white" : "border-ink-100 bg-white text-ink-700 hover:bg-ink-50"}`;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">PARS RNS</h1>
        <p className="text-sm text-ink-500">
          CBSA Release Notification System messages for our PARS shipments: release code, time,
          office and sub-location, transaction and container numbers.
        </p>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <Link key={r} href={`/pars-rns?range=${r}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className={chip(rangeDays === r)}>
            {r === 1 ? "Today" : `Last ${r} days`}
          </Link>
        ))}
        <form className="ml-auto" method="get">
          <input type="hidden" name="range" value={rangeDays} />
          <Input name="q" defaultValue={q ?? ""} placeholder="PARS #, transaction #, container #" aria-label="Search RNS" className="w-72" />
        </form>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-3 py-2 font-medium">PARS #</th>
              <th className="px-3 py-2 font-medium">Release code</th>
              <th className="px-3 py-2 font-medium">Released</th>
              <th className="px-3 py-2 font-medium">Office</th>
              <th className="px-3 py-2 font-medium">Sub-location</th>
              <th className="px-3 py-2 font-medium">Transaction #</th>
              <th className="px-3 py-2 font-medium">Container #</th>
              <th className="px-3 py-2 font-medium">Received</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {feed.rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-5 text-ink-500">
                  No RNS messages in this range.
                </td>
              </tr>
            )}
            {feed.rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2 font-mono text-xs">
                  {r.movementId ? (
                    <Link href={`/movements/${r.movementId}`} className="hover:underline">
                      {r.parsNumber}
                    </Link>
                  ) : (
                    r.parsNumber
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{r.releaseCode ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{fmt(r.releasedAt)}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.officeCode ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.sublocationCode ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.transactionNumber ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.containerNumber ?? "—"}</td>
                <td className="px-3 py-2 text-xs text-ink-500">{fmt(r.receivedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
