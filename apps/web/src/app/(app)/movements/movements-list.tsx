"use client";

/**
 * The movements table with the list tools (Task 14): search in one column,
 * page size, auto-refresh and a column chooser, all remembered per browser.
 * The status / regime / port filters stay in the URL and arrive as props.
 */
import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  MOVEMENT_SEARCH_COLUMNS,
  type MovementSearchColumn,
  type MovementStatus,
  type Regime,
} from "@corridor/domain";
import { Card } from "@corridor/ui";
import { ColumnChooser } from "@/components/list/column-chooser";
import { ListToolbar } from "@/components/list/list-toolbar";
import { useAutoRefresh } from "@/components/list/use-auto-refresh";
import { useListPrefs } from "@/components/list/use-list-prefs";
import { useTRPC } from "@/lib/trpc/client";
import {
  MOVEMENT_COLUMNS,
  MovementsTable,
  type MovementColumnKey,
  type MovementRow,
} from "./movements-table";

const COLUMN_KEYS = MOVEMENT_COLUMNS.map((c) => c.key);
const DEFAULT_COLUMNS: MovementColumnKey[] = [...COLUMN_KEYS];
const DEFAULTS = { columns: DEFAULT_COLUMNS as string[], pageSize: 25, autoRefreshSec: 0 };

const fmt = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "—";

export function MovementsList({
  status,
  regime,
  portId,
  initialSearch,
}: {
  status?: MovementStatus;
  regime?: Regime;
  portId?: string;
  initialSearch?: string;
}) {
  const trpc = useTRPC();
  const [prefs, setPrefs] = useListPrefs("movements", DEFAULTS, COLUMN_KEYS);
  const [search, setSearch] = useState(initialSearch ?? "");
  const [searchColumn, setSearchColumn] = useState<MovementSearchColumn | "">("");
  const [page, setPage] = useState(0);

  const input = useMemo(
    () => ({
      status: status ? [status] : undefined,
      regime,
      portId,
      search: search.trim() || undefined,
      searchColumn: searchColumn || undefined,
      pageSize: prefs.pageSize,
      limit: prefs.pageSize,
      offset: page * prefs.pageSize,
    }),
    [status, regime, portId, search, searchColumn, prefs.pageSize, page],
  );
  const list = useQuery(
    trpc.movement.list.queryOptions(input, { placeholderData: keepPreviousData }),
  );
  const { secondsLeft } = useAutoRefresh(prefs.autoRefreshSec, () => list.refetch());

  const rows: MovementRow[] = (list.data?.rows ?? []).map((m) => ({
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
    readyToCross: m.readyToCross,
  }));

  return (
    <div className="space-y-3">
      <ListToolbar
        search={search}
        onSearch={(v) => {
          setSearch(v);
          setPage(0);
        }}
        searchLabel="Search movements"
        searchPlaceholder="Search movement #, trip, customs ref…"
        searchColumns={MOVEMENT_SEARCH_COLUMNS}
        searchColumn={searchColumn}
        onSearchColumn={(v) => {
          setSearchColumn(v as MovementSearchColumn | "");
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
      >
        <ColumnChooser
          columns={MOVEMENT_COLUMNS}
          selected={prefs.columns as MovementColumnKey[]}
          defaults={DEFAULT_COLUMNS}
          onChange={(cols) => setPrefs({ columns: cols })}
        />
        <span className="text-xs text-fg-secondary">
          {list.data ? `${list.data.total} total` : ""}
        </span>
      </ListToolbar>
      <Card className="overflow-x-auto">
        <MovementsTable
          rows={rows}
          visible={prefs.columns}
          isLoading={list.isLoading}
          pageIndex={page}
          pageSize={prefs.pageSize}
          total={list.data?.total}
          onPageChange={setPage}
        />
      </Card>
    </div>
  );
}
