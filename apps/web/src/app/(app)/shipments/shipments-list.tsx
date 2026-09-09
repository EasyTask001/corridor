"use client";

/**
 * The shipments table with the list tools (Task 14): search in one column,
 * page size, auto-refresh, a column chooser and a checkbox column whose only
 * bulk action is deleting draft shipments. Status / regime / unassigned
 * filters stay in the URL and arrive as props.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SHIPMENT_SEARCH_COLUMNS,
  type Regime,
  type ShipmentSearchColumn,
  type ShipmentStatus,
} from "@corridor/domain";
import { Button, Card } from "@corridor/ui";
import { ColumnChooser } from "@/components/list/column-chooser";
import { ListToolbar } from "@/components/list/list-toolbar";
import { useAutoRefresh } from "@/components/list/use-auto-refresh";
import { useListPrefs } from "@/components/list/use-list-prefs";
import { useTRPC } from "@/lib/trpc/client";

const COLUMNS = [
  { key: "controlNumber", label: "Control number" },
  { key: "regime", label: "Regime" },
  { key: "type", label: "Type" },
  { key: "shipper", label: "Shipper" },
  { key: "lines", label: "Lines" },
  { key: "movement", label: "Movement" },
  { key: "status", label: "Status" },
  { key: "entryNumber", label: "Entry number" },
  { key: "updated", label: "Updated" },
] as const;
type ColumnKey = (typeof COLUMNS)[number]["key"];
const COLUMN_KEYS = COLUMNS.map((c) => c.key);
const DEFAULT_COLUMNS: ColumnKey[] = [
  "controlNumber",
  "regime",
  "type",
  "shipper",
  "lines",
  "movement",
  "status",
];
const DEFAULTS = { columns: DEFAULT_COLUMNS as string[], pageSize: 25, autoRefreshSec: 0 };

const kindOf = (s: { shipmentType: string | null; cargoType: string | null }) =>
  (s.shipmentType ?? s.cargoType ?? "—").replace(/_/g, " ");

export function ShipmentsList({
  status,
  regime,
  unassignedOnly,
  initialSearch,
  canWrite,
}: {
  status?: ShipmentStatus;
  regime?: Regime;
  unassignedOnly?: boolean;
  initialSearch?: string;
  canWrite: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [prefs, setPrefs] = useListPrefs("shipments", DEFAULTS, COLUMN_KEYS);
  const [search, setSearch] = useState(initialSearch ?? "");
  const [searchColumn, setSearchColumn] = useState<ShipmentSearchColumn | "">("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const input = useMemo(
    () => ({
      status: status ? [status] : undefined,
      regime,
      unassignedOnly: unassignedOnly || undefined,
      q: search.trim() || undefined,
      searchColumn: searchColumn || undefined,
      pageSize: prefs.pageSize,
      limit: prefs.pageSize,
      offset: page * prefs.pageSize,
    }),
    [status, regime, unassignedOnly, search, searchColumn, prefs.pageSize, page],
  );
  const list = useQuery(
    trpc.shipment.list.queryOptions(input, { placeholderData: keepPreviousData }),
  );
  const { secondsLeft } = useAutoRefresh(prefs.autoRefreshSec, () => list.refetch());
  const bulkRemove = useMutation(
    trpc.shipment.bulkRemove.mutationOptions({
      onSuccess: (r) => {
        setSelected(new Set());
        setNotice(
          r.skipped.length
            ? `Deleted ${r.deleted}; ${r.skipped.length} not deleted (not drafts): ${r.skipped.join(", ")}.`
            : `Deleted ${r.deleted} shipment${r.deleted === 1 ? "" : "s"}.`,
        );
        void qc.invalidateQueries({ queryKey: trpc.shipment.pathKey() });
      },
      onError: (e) => setNotice(e.message),
    }),
  );

  const rows = list.data?.rows ?? [];
  const visible = prefs.columns as ColumnKey[];
  const show = (k: ColumnKey) => visible.includes(k);
  const pageIds = rows.map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPage) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pageCount = Math.max(1, Math.ceil((list.data?.total ?? 0) / prefs.pageSize));

  return (
    <div className="space-y-3">
      <ListToolbar
        search={search}
        onSearch={(v) => {
          setSearch(v);
          setPage(0);
        }}
        searchLabel="Search shipments"
        searchPlaceholder="Search control, entry or in-bond number…"
        searchColumns={SHIPMENT_SEARCH_COLUMNS}
        searchColumn={searchColumn}
        onSearchColumn={(v) => {
          setSearchColumn(v as ShipmentSearchColumn | "");
          setPage(0);
        }}
        pageSize={prefs.pageSize}
        onPageSize={(n) => {
          setPrefs({ pageSize: n });
          setPage(0);
        }}
        autoRefreshSec={prefs.autoRefreshSec}
        onAutoRefresh={(n) => setPrefs({ autoRefreshSec: n })}
        secondsLeft={secondsLeft}
        selectedCount={selected.size}
        onClearSelection={() => setSelected(new Set())}
        bulkActions={
          canWrite
            ? [
                {
                  label: "Delete selected drafts",
                  tone: "danger",
                  disabled: bulkRemove.isPending,
                  onClick: () => bulkRemove.mutate({ ids: [...selected] }),
                },
              ]
            : []
        }
      >
        <ColumnChooser
          columns={COLUMNS}
          selected={visible}
          defaults={DEFAULT_COLUMNS}
          onChange={(cols) => setPrefs({ columns: cols })}
        />
        <span className="text-xs text-fg-secondary">
          {list.data ? `${list.data.total} total` : ""}
        </span>
      </ListToolbar>
      {notice && (
        <p role="status" className="rounded-md bg-surface-sunken px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-fg-secondary">
            <tr>
              {canWrite && (
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allOnPage}
                    onChange={toggleAll}
                  />
                </th>
              )}
              {show("controlNumber") && <th className="px-3 py-2 font-medium">Control number</th>}
              {show("regime") && <th className="px-3 py-2 font-medium">Regime</th>}
              {show("type") && <th className="px-3 py-2 font-medium">Type</th>}
              {show("shipper") && <th className="px-3 py-2 font-medium">Shipper</th>}
              {show("lines") && <th className="px-3 py-2 text-right font-medium">Lines</th>}
              {show("movement") && <th className="px-3 py-2 font-medium">Movement</th>}
              {show("status") && <th className="px-3 py-2 font-medium">Status</th>}
              {show("entryNumber") && <th className="px-3 py-2 font-medium">Entry number</th>}
              {show("updated") && <th className="px-3 py-2 font-medium">Updated</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {list.isLoading && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-fg-secondary">
                  Loading…
                </td>
              </tr>
            )}
            {!list.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-fg-secondary">
                  No shipments match these filters.
                </td>
              </tr>
            )}
            {rows.map((s) => (
              <tr key={s.id} className={selected.has(s.id) ? "bg-surface-sunken" : undefined}>
                {canWrite && (
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${s.controlNumber}`}
                      checked={selected.has(s.id)}
                      onChange={() => toggle(s.id)}
                    />
                  </td>
                )}
                {show("controlNumber") && (
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/shipments/${s.id}`} className="hover:underline">
                      {s.controlNumber}
                    </Link>
                    {s.isPars && (
                      <span className="ml-2 text-[10px] uppercase text-fg-secondary">PARS</span>
                    )}
                  </td>
                )}
                {show("regime") && <td className="px-3 py-2 font-mono text-xs">{s.regime}</td>}
                {show("type") && <td className="px-3 py-2 capitalize">{kindOf(s)}</td>}
                {show("shipper") && <td className="px-3 py-2">{s.shipperName ?? "—"}</td>}
                {show("lines") && (
                  <td className="px-3 py-2 text-right font-mono">{s.commodityCount}</td>
                )}
                {show("movement") && (
                  <td className="px-3 py-2 font-mono text-xs">
                    {s.movementId ? (
                      <Link href={`/movements/${s.movementId}`} className="hover:underline">
                        {s.movementNumber}
                      </Link>
                    ) : (
                      <span className="text-fg-secondary">unassigned</span>
                    )}
                  </td>
                )}
                {show("status") && (
                  <td className="px-3 py-2 capitalize">{s.status.replace(/_/g, " ")}</td>
                )}
                {show("entryNumber") && (
                  <td className="px-3 py-2 font-mono text-xs">{s.entryNumber ?? "—"}</td>
                )}
                {show("updated") && (
                  <td className="px-3 py-2 text-xs text-fg-secondary">
                    {new Date(s.updatedAt).toLocaleString("en-CA", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-border-default px-3 py-2 text-xs text-fg-secondary">
            <span>
              Page {page + 1} of {pageCount}
            </span>
            <span className="flex gap-2">
              <Button
                variant="ghost"
                size="xs"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}
