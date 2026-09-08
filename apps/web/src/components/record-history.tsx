"use client";

/**
 * "History" on a record: the audit rows for exactly this entity, in a dialog,
 * fetched only when opened. What changed is shown as before → after pairs of
 * the top-level fields that differ.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "@corridor/ui";
import { useTRPC } from "@/lib/trpc/client";

type EntityType =
  | "movement"
  | "shipment"
  | "driver"
  | "truck"
  | "trailer"
  | "partner"
  | "in_bond_record"
  | "external_shipment"
  | "import_batch"
  | "generated_document";

const show = (v: unknown) =>
  v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);

function diff(before: unknown, after: unknown): Array<{ key: string; from: unknown; to: unknown }> {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out: Array<{ key: string; from: unknown; to: unknown }> = [];
  for (const key of keys) {
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) out.push({ key, from: b[key], to: a[key] });
  }
  return out.slice(0, 12);
}

export function RecordHistoryDialog({
  entityType,
  entityId,
  label,
  size = "xs",
}: {
  entityType: EntityType;
  entityId: string;
  label?: string;
  size?: "xs" | "sm";
}) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const history = useQuery(trpc.audit.forEntity.queryOptions({ entityType, entityId, limit: 50 }, { enabled: open }));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="ghost" size={size} className="px-0 py-0" onClick={() => setOpen(true)}>
        History
      </Button>
      <DialogContent aria-describedby={undefined} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>History{label ? ` · ${label}` : ""}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto text-sm">
          {history.isLoading && <p className="text-ink-500">Loading…</p>}
          {history.error && (
            <p role="alert" className="text-danger-500">
              {history.error.message}
            </p>
          )}
          {history.data?.length === 0 && <p className="text-ink-500">Nothing recorded yet.</p>}
          <ol className="space-y-3" aria-label="Record history">
            {history.data?.map((row) => {
              const changes = diff(row.before, row.after);
              return (
                <li key={row.id} className="border-b border-ink-100 pb-3 last:border-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 text-xs text-ink-500">
                    <span className="font-mono">
                      {new Date(row.createdAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                    <span>{row.actorName ?? (row.actorId ? "a user" : "system")}</span>
                    <span className="font-mono text-ink-950">{row.action}</span>
                  </div>
                  {changes.length > 0 && (
                    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                      {changes.map((c) => (
                        <div key={c.key} className="contents">
                          <dt className="font-mono text-ink-500">{c.key}</dt>
                          <dd className="truncate">
                            <span className="text-ink-500 line-through">{show(c.from)}</span> {show(c.to)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
        <div className="mt-4 text-right">
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              Close
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
