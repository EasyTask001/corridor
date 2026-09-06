import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { movementStatus, type MovementStatus } from "@corridor/domain";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { StatusBadge } from "@/components/movement/status-badge";
import { createMovement } from "./actions";

export const metadata: Metadata = { title: "Movements" };

const STATUS_ORDER: MovementStatus[] = [
  "draft",
  "sent",
  "accepted",
  "held",
  "released",
  "rejected",
  "arrived",
  "cancelled",
];

export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; regime?: string; q?: string }>;
}) {
  const session = await getSession();
  if (!session?.permissions.has("movement.read")) redirect("/dashboard");
  const canWrite = session.permissions.has("movement.write");

  const sp = await searchParams;
  const status = movementStatus.safeParse(sp.status).success
    ? (sp.status as MovementStatus)
    : undefined;
  const regime = sp.regime === "ACE" || sp.regime === "ACI" ? sp.regime : undefined;
  const q = sp.q?.trim() || undefined;

  const caller = await api();
  const [board, list] = await Promise.all([
    caller.movement.board(),
    caller.movement.list({
      status: status ? [status] : undefined,
      regime,
      search: q,
      limit: 100,
      offset: 0,
    }),
  ]);

  const href = (patch: Partial<{ status: string; regime: string; q: string }>) => {
    const p = new URLSearchParams();
    const next = { status: sp.status, regime: sp.regime, q: sp.q, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/movements?${s}` : "/movements";
  };

  const fmt = (d: Date | null) =>
    d ? d.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "—";

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Movements</h1>
          <p className="text-sm text-ink-500">ACE (US-bound) and ACI (Canada-bound) e-manifests.</p>
        </div>
        {canWrite && (
          <div className="flex gap-2">
            <form action={createMovement}>
              <input type="hidden" name="regime" value="ACE" />
              <button className="btn-primary">New ACE movement</button>
            </form>
            <form action={createMovement}>
              <input type="hidden" name="regime" value="ACI" />
              <button className="btn-signal">New ACI movement</button>
            </form>
          </div>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={href({ status: undefined })}
          className={`rounded-full border px-3 py-1 text-xs ${!status ? "border-ink-950 bg-ink-950 text-white" : "border-ink-100 bg-white text-ink-700 hover:bg-ink-50"}`}
        >
          All
        </Link>
        {STATUS_ORDER.map((s) => (
          <Link
            key={s}
            href={href({ status: s })}
            className={`rounded-full border px-3 py-1 text-xs capitalize ${status === s ? "border-ink-950 bg-ink-950 text-white" : "border-ink-100 bg-white text-ink-700 hover:bg-ink-50"}`}
          >
            {s} <span className="ml-1 font-mono opacity-70">{board[s] ?? 0}</span>
          </Link>
        ))}
        <span className="mx-2 h-4 w-px bg-ink-100" />
        {(["ACE", "ACI"] as const).map((r) => (
          <Link
            key={r}
            href={href({ regime: regime === r ? undefined : r })}
            className={`rounded-full border px-3 py-1 font-mono text-xs ${regime === r ? "border-ink-950 bg-ink-950 text-white" : "border-ink-100 bg-white text-ink-700 hover:bg-ink-50"}`}
          >
            {r}
          </Link>
        ))}
        <form className="ml-auto" method="get">
          {status && <input type="hidden" name="status" value={status} />}
          {regime && <input type="hidden" name="regime" value={regime} />}
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search movement #, trip, customs ref…"
            aria-label="Search movements"
            className="input w-72"
          />
        </form>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2 font-medium">Movement</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Crossing</th>
              <th className="px-4 py-2 font-medium">ETA</th>
              <th className="px-4 py-2 font-medium">Driver</th>
              <th className="px-4 py-2 font-medium">Truck / Trailer</th>
              <th className="px-4 py-2 font-medium">Lines</th>
              <th className="px-4 py-2 font-medium">Customs ref</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {list.rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-ink-500">
                  No movements match.
                </td>
              </tr>
            )}
            {list.rows.map((m) => (
              <tr key={m.id} className="hover:bg-ink-50">
                <td className="px-4 py-2">
                  <Link
                    href={`/movements/${m.id}`}
                    className="font-mono font-medium hover:underline"
                  >
                    {m.movementNumber}
                  </Link>
                  {m.tripNumber && <div className="text-xs text-ink-500">{m.tripNumber}</div>}
                </td>
                <td className="px-4 py-2">
                  <StatusBadge status={m.status} />
                </td>
                <td className="px-4 py-2">
                  {m.crossingPoint?.name ?? m.crossingPoint?.code ?? "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-ink-700">
                  {fmt(m.scheduledCrossingAt)}
                </td>
                <td className="px-4 py-2">{m.driverName ?? "—"}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  {m.truckUnit ?? "—"} / {m.trailerUnit ?? "—"}
                </td>
                <td className="px-4 py-2 font-mono">{m.cargoCount}</td>
                <td className="px-4 py-2 font-mono text-xs">{m.customsReferenceNumber ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
