"use client";

/**
 * The crossing log: every movement in a date range as a table whose columns
 * the dispatcher picks (remembered per browser), filtered by regime, driver,
 * port or equipment, and exported to CSV or PDF as a stored document.
 */
import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CROSSING_REPORT_COLUMNS,
  DEFAULT_CROSSING_COLUMNS,
  crossingColumn,
  type CrossingColumn,
} from "@corridor/domain";
import { Button, Input, Label, NativeSelect } from "@corridor/ui";
import { PortPicker } from "@/components/port-picker";
import { ColumnPicker } from "@/components/reports/column-picker";
import { useTRPC } from "@/lib/trpc/client";

const STORAGE_KEY = "corridor.report.columns";
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = () => {
  const d = new Date();
  return isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
};

/**
 * The column choice lives in this browser. Reading it through an external
 * store keeps the server render on the defaults and lets React swap in the
 * stored choice after hydration without a state update inside an effect.
 */
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedColumns: CrossingColumn[] = DEFAULT_CROSSING_COLUMNS;
function readStoredColumns(): CrossingColumn[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedColumns;
  cachedRaw = raw;
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    const cols = Array.isArray(parsed)
      ? parsed.filter((k) => crossingColumn.safeParse(k).success)
      : [];
    cachedColumns = cols.length > 0 ? (cols as CrossingColumn[]) : DEFAULT_CROSSING_COLUMNS;
  } catch {
    cachedColumns = DEFAULT_CROSSING_COLUMNS;
  }
  return cachedColumns;
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function storeColumns(next: CrossingColumn[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    cachedRaw = undefined;
    cachedColumns = next;
  }
  listeners.forEach((cb) => cb());
}

export function CrossingReport() {
  const trpc = useTRPC();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [regime, setRegime] = useState<"" | "ACE" | "ACI">("");
  const [driverId, setDriverId] = useState("");
  const [truckId, setTruckId] = useState("");
  const [trailerId, setTrailerId] = useState("");
  const [portId, setPortId] = useState<string | null>(null);
  const columns = useSyncExternalStore(
    subscribe,
    readStoredColumns,
    () => DEFAULT_CROSSING_COLUMNS,
  );
  const [exported, setExported] = useState<{ url: string; format: string } | null>(null);
  const pickColumns = storeColumns;

  const filters = {
    from,
    to,
    regime: regime || undefined,
    driverId: driverId || undefined,
    truckId: truckId || undefined,
    trailerId: trailerId || undefined,
    portId: portId ?? undefined,
  };
  const { data: options } = useQuery(trpc.movement.options.queryOptions());
  const report = useQuery(
    trpc.reporting.crossings.queryOptions(
      { ...filters, columns, limit: 200, offset: 0 },
      { enabled: from <= to },
    ),
  );
  const exportReport = useMutation(
    trpc.reporting.export.mutationOptions({
      onSuccess: (r) => setExported({ url: r.signedUrl, format: r.format }),
    }),
  );

  return (
    <div className="space-y-4">
      <section className="panel space-y-3 p-5" aria-label="Crossing report filters">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label htmlFor="xFrom">From</Label>
            <Input id="xFrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="xTo">To</Label>
            <Input id="xTo" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="xRegime">Regime</Label>
            <NativeSelect
              id="xRegime"
              value={regime}
              onChange={(e) => setRegime(e.target.value as "" | "ACE" | "ACI")}
            >
              <option value="">Both</option>
              <option value="ACE">ACE (US-bound)</option>
              <option value="ACI">ACI (Canada-bound)</option>
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="xPort">Port</Label>
            <PortPicker
              id="xPort"
              regime={regime || undefined}
              onSelect={(p) => setPortId(p?.id ?? null)}
              placeholder="Any port"
            />
          </div>
          <div>
            <Label htmlFor="xDriver">Driver</Label>
            <NativeSelect
              id="xDriver"
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
            >
              <option value="">Any driver</option>
              {options?.drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="xTruck">Truck</Label>
            <NativeSelect id="xTruck" value={truckId} onChange={(e) => setTruckId(e.target.value)}>
              <option value="">Any truck</option>
              {options?.trucks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="xTrailer">Trailer</Label>
            <NativeSelect
              id="xTrailer"
              value={trailerId}
              onChange={(e) => setTrailerId(e.target.value)}
            >
              <option value="">Any trailer</option>
              {options?.trailers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex items-end">
            <ColumnPicker
              columns={CROSSING_REPORT_COLUMNS}
              selected={columns}
              defaults={DEFAULT_CROSSING_COLUMNS}
              onChange={pickColumns}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg-secondary">
            {report.data
              ? `${report.data.total} crossing${report.data.total === 1 ? "" : "s"}`
              : report.isLoading
                ? "Loading…"
                : ""}
            {from > to && "The range ends before it starts."}
          </span>
          <span className="ml-auto flex items-center gap-2">
            {(["csv", "pdf"] as const).map((format) => (
              <Button
                key={format}
                variant="secondary"
                size="sm"
                disabled={exportReport.isPending || !report.data}
                onClick={() =>
                  exportReport.mutate({
                    format,
                    source: { kind: "crossings", query: { ...filters, columns } },
                  })
                }
              >
                Export {format.toUpperCase()}
              </Button>
            ))}
            {exported && (
              <a
                href={exported.url}
                target="_blank"
                rel="noopener"
                data-testid="report-export-link"
                className="font-medium underline underline-offset-2"
              >
                Download {exported.format.toUpperCase()}
              </a>
            )}
          </span>
        </div>
        {(report.error || exportReport.error) && (
          <p
            role="alert"
            className="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-status-danger"
          >
            {report.error?.message ?? exportReport.error?.message}
          </p>
        )}
      </section>

      <section className="panel overflow-x-auto" aria-label="Crossing report">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-fg-secondary">
            <tr>
              {(report.data?.columns ?? []).map((c) => (
                <th key={c.key} className="whitespace-nowrap px-3 py-2 font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {report.data?.rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-5 text-fg-secondary">
                  No crossings in this range.
                </td>
              </tr>
            )}
            {report.data?.rows.map((row) => (
              <tr key={row.id}>
                {report.data.columns.map((c) => {
                  const v = row[c.key];
                  const text =
                    v === null || v === undefined
                      ? "—"
                      : typeof v === "number"
                        ? v.toLocaleString("en-CA")
                        : v;
                  return (
                    <td
                      key={c.key}
                      className={`whitespace-nowrap px-3 py-2 ${typeof v === "number" ? "text-right font-mono text-xs" : ""}`}
                    >
                      {c.key === "movementNumber" ? (
                        <Link
                          href={`/movements/${row.id}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {text}
                        </Link>
                      ) : (
                        text
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
