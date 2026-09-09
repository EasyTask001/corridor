import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { movementStatus, uuid, type MovementStatus } from "@corridor/domain";
import { Button, buttonVariants } from "@corridor/ui";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { BlankSheetsDialog } from "./blank-sheets-dialog";
import { MovementsPortFilter } from "./port-filter";
import { MovementsList } from "./movements-list";
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
  const board = await caller.movement.board();

  const href = (patch: Partial<{ status: string; regime: string; q: string }>) => {
    const p = new URLSearchParams();
    const next = { status: sp.status, regime: sp.regime, q: sp.q, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/movements?${s}` : "/movements";
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Movements</h1>
          <p className="text-sm text-fg-secondary">
            ACE (US-bound) and ACI (Canada-bound) e-manifests.
          </p>
        </div>
        {canWrite && (
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
            <form action={createMovement} className="contents sm:block">
              <input type="hidden" name="regime" value="ACE" />
              <Button className="w-full">New ACE movement</Button>
            </form>
            <form action={createMovement} className="contents sm:block">
              <input type="hidden" name="regime" value="ACI" />
              <Button variant="signal" className="w-full">
                New ACI movement
              </Button>
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
          className={`rounded-full border px-3 py-1 text-xs ${!status ? "border-accent bg-accent text-accent-fg" : "border-border-default bg-surface-raised text-fg-primary hover:bg-surface-sunken"}`}
        >
          All
        </Link>
        {STATUS_ORDER.map((s) => (
          <Link
            key={s}
            href={href({ status: s })}
            className={`rounded-full border px-3 py-1 text-xs capitalize ${status === s ? "border-accent bg-accent text-accent-fg" : "border-border-default bg-surface-raised text-fg-primary hover:bg-surface-sunken"}`}
          >
            {s} <span className="ml-1 font-mono opacity-70">{board[s] ?? 0}</span>
          </Link>
        ))}
        <span className="mx-2 h-4 w-px bg-surface-sunken" />
        {(["ACE", "ACI"] as const).map((r) => (
          <Link
            key={r}
            href={href({ regime: regime === r ? undefined : r })}
            className={`rounded-full border px-3 py-1 font-mono text-xs ${regime === r ? "border-accent bg-accent text-accent-fg" : "border-border-default bg-surface-raised text-fg-primary hover:bg-surface-sunken"}`}
          >
            {r}
          </Link>
        ))}
        <MovementsPortFilter regime={regime} active={!!portId} />
      </div>

      <MovementsList status={status} regime={regime} portId={portId} initialSearch={q} />
    </div>
  );
}
