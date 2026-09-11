"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MovementStatus } from "@corridor/domain";
import { createDataTableColumns, DataTable, type DataTableColumnDef } from "@corridor/ui";
import { StatusBadge } from "@/components/movement/status-badge";

/**
 * Serialisable projection of `movement.list` rows. The page is a Server
 * Component and formats the crossing/ETA labels there, so the table renders
 * identically on the server and after hydration regardless of the browser's
 * locale or time zone.
 */
export interface MovementRow {
  id: string;
  movementNumber: string;
  tripNumber: string | null;
  status: MovementStatus;
  crossingLabel: string;
  etaLabel: string;
  driverLabel: string;
  unitsLabel: string;
  shipmentCount: number;
  customsReferenceLabel: string;
}

/** Every column the table can show, for the column chooser (Task 14). */
export const MOVEMENT_COLUMNS = [
  { key: "movement", label: "Movement" },
  { key: "status", label: "Status" },
  { key: "crossing", label: "Crossing" },
  { key: "eta", label: "ETA" },
  { key: "driver", label: "Driver" },
  { key: "units", label: "Truck / Trailer" },
  { key: "shipments", label: "Shipments" },
  { key: "customsRef", label: "Customs ref" },
] as const;
export type MovementColumnKey = (typeof MOVEMENT_COLUMNS)[number]["key"];

export function MovementsTable({
  rows,
  visible,
  isLoading,
  pageIndex,
  pageSize,
  total,
  onPageChange,
}: {
  rows: MovementRow[];
  /** Column keys to show, in table order; omitted = all. */
  visible?: readonly string[];
  isLoading?: boolean;
  pageIndex?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (pageIndex: number) => void;
}) {
  const router = useRouter();

  const allColumns = useMemo<DataTableColumnDef<MovementRow>[]>(() => {
    const helper = createDataTableColumns<MovementRow>();
    return helper.columns([
      helper.display({
        id: "movement",
        header: "Movement",
        cell: ({ row }) => (
          <>
            <Link
              href={`/movements/${row.original.id}`}
              className="font-mono font-medium hover:underline"
            >
              {row.original.movementNumber}
            </Link>
            {row.original.tripNumber && (
              <div className="text-xs text-fg-secondary">{row.original.tripNumber}</div>
            )}
          </>
        ),
      }),
      helper.display({
        id: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      }),
      helper.accessor("crossingLabel", { id: "crossing", header: "Crossing" }),
      helper.accessor("etaLabel", {
        id: "eta",
        header: "ETA",
        meta: { className: "whitespace-nowrap text-fg-primary" },
      }),
      helper.accessor("driverLabel", { id: "driver", header: "Driver" }),
      helper.accessor("unitsLabel", {
        id: "units",
        header: "Truck / Trailer",
        meta: { className: "font-mono text-xs" },
      }),
      helper.accessor("shipmentCount", {
        id: "shipments",
        header: "Shipments",
        meta: { className: "font-mono" },
      }),
      helper.accessor("customsReferenceLabel", {
        id: "customsRef",
        header: "Customs ref",
        meta: { className: "font-mono text-xs" },
      }),
    ]);
  }, []);
  const columns = useMemo(
    () => (visible ? allColumns.filter((c) => visible.includes(c.id as string)) : allColumns),
    [allColumns, visible],
  );

  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={(row) => row.id}
      isLoading={isLoading}
      emptyMessage="No movements match."
      rowClassName={() => "hover:bg-surface-sunken"}
      onRowClick={(row) => router.push(`/movements/${row.id}`)}
      getRowAriaLabel={(row) => `Open movement ${row.movementNumber}`}
      pageIndex={pageIndex}
      pageSize={pageSize}
      total={total}
      onPageChange={onPageChange}
    />
  );
}
