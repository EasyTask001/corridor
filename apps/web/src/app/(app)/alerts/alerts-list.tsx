"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AlertStatus } from "@corridor/domain";
import { useTRPC } from "@/lib/trpc/client";

const TABS: { label: string; status: AlertStatus[] }[] = [
  { label: "Open", status: ["open", "acknowledged"] },
  { label: "Resolved", status: ["resolved"] },
  { label: "Dismissed", status: ["dismissed"] },
];

export function SeverityBadge({ severity }: { severity: string }) {
  const cls =
    severity === "critical"
      ? "bg-danger-500/10 text-danger-500"
      : severity === "warning"
        ? "bg-warn-500/10 text-warn-500"
        : "bg-ink-100 text-ink-500";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${cls}`}>
      {severity}
    </span>
  );
}

export function AlertsList({ canManage }: { canManage: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [tab, setTab] = useState(0);
  const listOpts = trpc.alerts.list.queryOptions({ status: TABS[tab]!.status, limit: 200 });
  const { data, isLoading } = useQuery(listOpts);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: trpc.alerts.list.queryKey() });
    qc.invalidateQueries({ queryKey: trpc.alerts.summary.queryKey() });
  };
  const setStatus = useMutation(trpc.alerts.setStatus.mutationOptions({ onSuccess: invalidate }));
  const rescan = useMutation(trpc.alerts.rescan.mutationOptions({ onSuccess: invalidate }));

  const entityLink = (a: NonNullable<typeof data>["rows"][number]) => {
    if (a.driverId) return { href: "/parties/drivers", label: a.driverName ?? "Driver" };
    if (a.truckId) return { href: "/parties/trucks", label: `Truck ${a.truckUnit ?? ""}` };
    if (a.trailerId) return { href: "/parties/trailers", label: `Trailer ${a.trailerUnit ?? ""}` };
    return null;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1 rounded-md bg-ink-100 p-0.5">
          {TABS.map((t, i) => (
            <button
              key={t.label}
              onClick={() => setTab(i)}
              className={`rounded px-3 py-1 text-sm ${
                i === tab ? "bg-white font-medium shadow-sm" : "text-ink-500 hover:text-ink-950"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {canManage && (
          <button
            className="btn-secondary"
            disabled={rescan.isPending}
            onClick={() => rescan.mutate()}
          >
            {rescan.isPending ? "Scanning…" : "Re-run checks"}
          </button>
        )}
      </div>

      <div className="panel divide-y divide-ink-100">
        {isLoading && <p className="px-5 py-6 text-sm text-ink-500">Loading…</p>}
        {!isLoading && data?.rows.length === 0 && (
          <p className="px-5 py-6 text-sm text-ink-500">Nothing here — all clear.</p>
        )}
        {data?.rows.map((a) => {
          const link = entityLink(a);
          return (
            <div key={a.id} className="flex items-start gap-4 px-5 py-4">
              <div className="pt-0.5">
                <SeverityBadge severity={a.severity} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{a.title}</div>
                {a.description && <p className="mt-0.5 text-sm text-ink-500">{a.description}</p>}
                <div className="mt-1.5 flex flex-wrap gap-x-4 text-xs text-ink-500">
                  {link && (
                    <Link href={link.href} className="underline hover:text-ink-950">
                      {link.label}
                    </Link>
                  )}
                  {a.dueAt && <span className="font-mono">due {a.dueAt}</span>}
                  <span className="capitalize">{a.status}</span>
                  <span>{a.alertType.replace(/_/g, " ")}</span>
                </div>
              </div>
              {canManage && (
                <div className="flex shrink-0 gap-2">
                  {a.status === "open" && (
                    <button
                      className="btn-secondary px-3 py-1 text-xs"
                      onClick={() => setStatus.mutate({ id: a.id, status: "acknowledged" })}
                    >
                      Acknowledge
                    </button>
                  )}
                  {(a.status === "open" || a.status === "acknowledged") && (
                    <>
                      <button
                        className="btn-secondary px-3 py-1 text-xs"
                        onClick={() => setStatus.mutate({ id: a.id, status: "resolved" })}
                      >
                        Resolve
                      </button>
                      <button
                        className="px-2 py-1 text-xs text-ink-500 hover:text-ink-950"
                        onClick={() => setStatus.mutate({ id: a.id, status: "dismissed" })}
                      >
                        Dismiss
                      </button>
                    </>
                  )}
                  {(a.status === "resolved" || a.status === "dismissed") && (
                    <button
                      className="btn-secondary px-3 py-1 text-xs"
                      onClick={() => setStatus.mutate({ id: a.id, status: "open" })}
                    >
                      Reopen
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
