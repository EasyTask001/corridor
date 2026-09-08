import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { movementStatus, uuid, type MovementStatus } from "@corridor/domain";
import { Button, buttonVariants, Card, Input } from "@corridor/ui";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { BlankSheetsDialog } from "./blank-sheets-dialog";
import { MovementsPortFilter } from "./port-filter";
import { MovementsTable, type MovementRow } from "./movements-table";
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
  searchParams: Promise<{ status?: string; regime?: string; q?: string; portId?: string }>;
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
  const portId = uuid.safeParse(sp.portId).success ? sp.portId : undefined;

  const caller = await api();
  const [board, list] = await Promise.all([
    caller.movement.board(),
    caller.movement.list({
      status: status ? [status] : undefined,
      regime,
      search: q,
      portId,
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

  // Formatted here (Server Component) so the client table stays serialisable
  // and renders the same string before and after hydration.
  const tableRows: MovementRow[] = list.rows.map((m) => ({
    id: m.id,
    movementNumber: m.movementNumber,
    tripNumber: m.tripNumber,
    status: m.status,
    crossingLabel: m.port?.name ?? m.port?.code ?? "—",
    etaLabel: fmt(m.scheduledCrossingAt),
    driverLabel: m.driverName ?? "—",
    unitsLabel: `${m.truckUnit ?? "—"} / ${m.trailerUnit ?? "—"}`,
    shipmentCount: m.shipmentCount,
    customsReferenceLabel: m.customsReferenceNumber ?? "—",
  }));

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Movements</h1>
          <p className="text-sm text-ink-500">ACE (US-bound) and ACI (Canada-bound) e-manifests.</p>
        </div>
        {canWrite && (
          <div className="flex items-center gap-2">
            <form action={createMovement}>
              <input type="hidden" name="regime" value="ACE" />
              <Button>New ACE movement</Button>
            </form>
            <form action={createMovement}>
              <input type="hidden" name="regime" value="ACI" />
              <Button variant="signal">New ACI movement</Button>
            </form>
            <Link href="/movements/new" className={buttonVariants({ variant: "secondary" })}>
              New movement…
            </Link>
            <BlankSheetsDialog />
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
        <MovementsPortFilter regime={regime} active={!!portId} />
        <form className="ml-auto" method="get">
          {status && <input type="hidden" name="status" value={status} />}
          {regime && <input type="hidden" name="regime" value={regime} />}
          {portId && <input type="hidden" name="portId" value={portId} />}
          <Input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search movement #, trip, customs ref…"
            aria-label="Search movements"
            className="w-72"
          />
        </form>
      </div>

      <Card className="overflow-x-auto">
        <MovementsTable rows={tableRows} />
      </Card>
    </div>
  );
}
