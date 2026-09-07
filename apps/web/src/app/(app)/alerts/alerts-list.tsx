"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AlertStatus } from "@corridor/domain";
import { Badge, Button, cn } from "@corridor/ui";
import { useTRPC } from "@/lib/trpc/client";

const TABS: { label: string; status: AlertStatus[] }[] = [
  { label: "Open", status: ["open", "acknowledged"] },
  { label: "Resolved", status: ["resolved"] },
  { label: "Dismissed", status: ["dismissed"] },
];

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge
      caps
      variant={severity === "critical" ? "danger" : severity === "warning" ? "warn" : "neutral"}
    >
      {severity}
    </Badge>
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

  /**
   * Acknowledging or resolving is a one-click action on a long list, so it
   * lands immediately: the row takes its new status and leaves the tab if the
   * tab no longer covers it. A failed mutation puts the snapshot back and the
   * `onSettled` invalidation reconciles with the server either way.
   */
  const setStatus = useMutation(
    trpc.alerts.setStatus.mutationOptions({
      onMutate: async ({ id, status }) => {
        await qc.cancelQueries({ queryKey: listOpts.queryKey });
        const previous = qc.getQueryData(listOpts.queryKey);
        const visible = TABS[tab]!.status;
        qc.setQueryData(listOpts.queryKey, (old) =>
          old
            ? {
                ...old,
                rows: old.rows
                  .map((r) => (r.id === id ? { ...r, status } : r))
                  .filter((r) => visible.includes(r.status)),
              }
            : undefined,
        );
        return { previous };
      },
      onError: (_e, _v, ctx) => {
        if (ctx?.previous !== undefined) qc.setQueryData(listOpts.queryKey, ctx.previous);
      },
      onSettled: invalidate,
    }),
  );
  const rescan = useMutation(trpc.alerts.rescan.mutationOptions({ onSuccess: invalidate }));

  const entityLink = (a: NonNullable<typeof data>["rows"][number]) => {
    if (a.driverId) return { href: "/parties/drivers", label: a.driverName ?? "Driver" };
    if (a.truckId) return { href: "/parties/trucks", label: `Truck ${a.truckUnit ?? ""}` };
    if (a.trailerId) return { href: "/parties/trailers", label: `Trailer ${a.trailerUnit ?? ""}` };
    if (a.movementId)
      return { href: `/movements/${a.movementId}`, label: a.movementNumber ?? "Movement" };
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
              className={cn(
                "rounded px-3 py-1 text-sm",
                i === tab ? "bg-white font-medium shadow-sm" : "text-ink-500 hover:text-ink-950",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {canManage && (
          <Button variant="secondary" disabled={rescan.isPending} onClick={() => rescan.mutate()}>
            {rescan.isPending ? "Scanning…" : "Re-run checks"}
          </Button>
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
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setStatus.mutate({ id: a.id, status: "acknowledged" })}
                    >
                      Acknowledge
                    </Button>
                  )}
                  {(a.status === "open" || a.status === "acknowledged") && (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setStatus.mutate({ id: a.id, status: "resolved" })}
                      >
                        Resolve
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setStatus.mutate({ id: a.id, status: "dismissed" })}
                      >
                        Dismiss
                      </Button>
                    </>
                  )}
                  {(a.status === "resolved" || a.status === "dismissed") && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setStatus.mutate({ id: a.id, status: "open" })}
                    >
                      Reopen
                    </Button>
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
