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
  cargoCount: number;
  customsReferenceLabel: string;
}

export function MovementsTable({ rows }: { rows: MovementRow[] }) {
  const router = useRouter();

  const columns = useMemo<DataTableColumnDef<MovementRow>[]>(() => {
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
              <div className="text-xs text-ink-500">{row.original.tripNumber}</div>
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
        meta: { className: "whitespace-nowrap text-ink-700" },
      }),
      helper.accessor("driverLabel", { id: "driver", header: "Driver" }),
      helper.accessor("unitsLabel", {
        id: "units",
        header: "Truck / Trailer",
        meta: { className: "font-mono text-xs" },
      }),
      helper.accessor("cargoCount", {
        id: "lines",
        header: "Lines",
        meta: { className: "font-mono" },
      }),
      helper.accessor("customsReferenceLabel", {
        id: "customsRef",
        header: "Customs ref",
        meta: { className: "font-mono text-xs" },
      }),
    ]);
  }, []);

  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={(row) => row.id}
      emptyMessage="No movements match."
      rowClassName={() => "hover:bg-ink-50"}
      onRowClick={(row) => router.push(`/movements/${row.id}`)}
    />
  );
}
