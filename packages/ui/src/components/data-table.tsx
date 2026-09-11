"use client";

import type { KeyboardEvent, ReactNode, SyntheticEvent } from "react";
import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type Row,
  type RowData,
  type TableOptions,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "./button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

/** Per-column presentation hooks; `meta` is typed through the feature set below. */
export interface DataTableColumnMeta {
  /** Extra classes for every body cell of the column. */
  className?: string;
  /** Extra classes for the column's header cell. */
  headerClassName?: string;
}

/**
 * The feature set every Corridor `DataTable` is built on: client-side sorting
 * plus an optional client-side global filter. Pagination is deliberately absent
 * — lists in this app page on the server, so the table renders the page it is
 * given and only draws the controls.
 */
// A typed (not asserted) placeholder value: `tableFeatures` infers its `ColumnMeta`
// generic from this value's declared type, not its literal shape, so the empty
// object still carries `className`/`headerClassName` through to `column.columnDef.meta`.
const emptyColumnMeta: DataTableColumnMeta = {};

export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString },
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
  columnMeta: emptyColumnMeta,
});

export type DataTableFeatures = typeof dataTableFeatures;
export type DataTableColumnDef<TData extends RowData> = ColumnDef<DataTableFeatures, TData>;
export type DataTableRow<TData extends RowData> = Row<DataTableFeatures, TData>;

/** Column helper bound to the `DataTable` feature set (typed `meta`, sorting, filtering). */
export function createDataTableColumns<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>();
}

export interface DataTableRowContext<TData extends RowData> {
  row: DataTableRow<TData>;
  /** The already-rendered `<td>` elements, so an override only re-wraps them. */
  cells: ReactNode;
}

export interface DataTableProps<TData extends RowData> {
  data: TData[];
  columns: DataTableColumnDef<TData>[];
  getRowId?: (row: TData, index: number) => string;
  /** Master switch for header sort controls; a column may still opt out. */
  enableSorting?: boolean;
  /** Controlled client-side global filter. Omit for server-side search. */
  globalFilter?: string;
  onGlobalFilterChange?: (value: string) => void;
  onRowClick?: (row: TData) => void;
  /** Accessible name for a clickable row; defaults to the row's first cell text. */
  getRowAriaLabel?: (row: TData) => string;
  rowClassName?: (row: TData) => string | undefined;
  isLoading?: boolean;
  loadingMessage?: ReactNode;
  emptyMessage?: ReactNode;
  /**
   * Escape hatch for rows that need their own wrapper element or extra rows.
   * The returned node replaces the default `<tr>`, so it must carry a `key`.
   */
  renderRow?: (context: DataTableRowContext<TData>) => ReactNode;
  /** Server-side pagination: the table renders controls, the caller re-fetches. */
  pageIndex?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (pageIndex: number) => void;
  className?: string;
  tableClassName?: string;
  "aria-label"?: string;
}

/** Events that originate on their own control must not also trigger the row action. */
function isInteractiveTarget(event: SyntheticEvent<HTMLTableRowElement>) {
  return Boolean(
    (event.target as HTMLElement | null)?.closest("a,button,input,select,textarea,label,summary"),
  );
}

function isActivationKey(event: KeyboardEvent<HTMLTableRowElement>) {
  return event.key === "Enter" || event.key === " ";
}

export function DataTable<TData extends RowData>({
  data,
  columns,
  getRowId,
  enableSorting = false,
  globalFilter,
  onGlobalFilterChange,
  onRowClick,
  getRowAriaLabel,
  rowClassName,
  isLoading = false,
  loadingMessage = "Loading…",
  emptyMessage = "No records.",
  renderRow,
  pageIndex,
  pageSize,
  total,
  onPageChange,
  className,
  tableClassName,
  "aria-label": ariaLabel,
}: DataTableProps<TData>) {
  const options: TableOptions<DataTableFeatures, TData> = {
    features: dataTableFeatures,
    data,
    columns,
    enableSorting,
    globalFilterFn: "includesString",
    ...(getRowId ? { getRowId } : {}),
    ...(globalFilter === undefined ? {} : { state: { globalFilter } }),
    ...(onGlobalFilterChange
      ? {
          onGlobalFilterChange: (updater: unknown) =>
            onGlobalFilterChange(
              typeof updater === "function"
                ? (updater as (old: string) => string)(globalFilter ?? "")
                : String(updater ?? ""),
            ),
        }
      : {}),
  };
  const table = useTable(options);

  const columnCount = table.getAllLeafColumns().length;
  const rows = table.getRowModel().rows;
  const pageCount =
    total !== undefined && pageSize ? Math.max(1, Math.ceil(total / pageSize)) : undefined;
  const showPagination =
    pageCount !== undefined && pageIndex !== undefined && onPageChange !== undefined;

  return (
    <div className={className}>
      <Table className={tableClassName} aria-label={ariaLabel}>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => {
                const sorted = enableSorting ? header.column.getIsSorted() : false;
                const canSort = enableSorting && header.column.getCanSort();
                const SortIcon =
                  sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ChevronsUpDown;
                return (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    className={header.column.columnDef.meta?.headerClassName}
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                    }
                  >
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex min-h-11 items-center gap-1 rounded px-1 uppercase tracking-wide transition-colors hover:bg-surface-raised hover:text-fg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40 sm:min-h-8"
                      >
                        <table.FlexRender header={header} />
                        <SortIcon
                          className={cn("size-3", sorted ? "opacity-100" : "opacity-40")}
                          aria-hidden
                        />
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell className="py-6 text-fg-secondary" colSpan={columnCount}>
                {loadingMessage}
              </TableCell>
            </TableRow>
          )}
          {!isLoading && rows.length === 0 && (
            <TableRow>
              <TableCell className="py-6 text-fg-secondary" colSpan={columnCount}>
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
          {!isLoading &&
            rows.map((row) => {
              const cells = row.getAllCells().map((cell) => (
                <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ));
              if (renderRow) return renderRow({ row, cells });
              return (
                <TableRow
                  key={row.id}
                  className={cn(
                    rowClassName?.(row.original),
                    onRowClick &&
                      "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring/40",
                  )}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-label={onRowClick ? getRowAriaLabel?.(row.original) : undefined}
                  onClick={
                    onRowClick
                      ? (event) => {
                          if (!isInteractiveTarget(event)) onRowClick(row.original);
                        }
                      : undefined
                  }
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (!isActivationKey(event) || isInteractiveTarget(event)) return;
                          event.preventDefault();
                          onRowClick(row.original);
                        }
                      : undefined
                  }
                >
                  {cells}
                </TableRow>
              );
            })}
        </TableBody>
      </Table>

      {showPagination && (
        <div className="flex items-center justify-between gap-3 border-t border-border-default px-4 py-3 text-xs text-fg-secondary">
          <span>
            Page {pageIndex + 1} of {pageCount} · {total} total
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pageIndex <= 0}
              onClick={() => onPageChange(pageIndex - 1)}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pageIndex + 1 >= pageCount}
              onClick={() => onPageChange(pageIndex + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
