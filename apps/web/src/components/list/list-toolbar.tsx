"use client";

/**
 * The shared list toolbar (Task 14): search with a column to search in, page
 * size, auto-refresh with a countdown, the column chooser, and the bulk
 * actions for whatever rows are ticked.
 */
import type { ReactNode } from "react";
import { Button, Input, NativeSelect } from "@corridor/ui";
import { PAGE_SIZES, REFRESH_INTERVALS } from "./use-list-prefs";

export interface BulkAction {
  label: string;
  onClick: () => void;
  tone?: "danger";
  disabled?: boolean;
}

export function ListToolbar({
  search,
  onSearch,
  searchPlaceholder,
  searchLabel = "Search",
  searchColumns,
  searchColumn,
  onSearchColumn,
  pageSize,
  onPageSize,
  autoRefreshSec,
  onAutoRefresh,
  secondsLeft,
  selectedCount = 0,
  bulkActions = [],
  onClearSelection,
  children,
}: {
  search: string;
  onSearch: (v: string) => void;
  searchPlaceholder?: string;
  searchLabel?: string;
  searchColumns?: ReadonlyArray<{ key: string; label: string }>;
  searchColumn?: string;
  onSearchColumn?: (v: string) => void;
  pageSize: number;
  onPageSize: (n: number) => void;
  autoRefreshSec: number;
  onAutoRefresh: (n: number) => void;
  secondsLeft?: number;
  selectedCount?: number;
  bulkActions?: BulkAction[];
  onClearSelection?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" role="toolbar" aria-label="List tools">
      <div className="flex items-center gap-1">
        {searchColumns && searchColumns.length > 0 && (
          <NativeSelect
            aria-label="Match on"
            value={searchColumn ?? ""}
            onChange={(e) => onSearchColumn?.(e.target.value)}
            className="w-40"
          >
            <option value="">All columns</option>
            {searchColumns.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </NativeSelect>
        )}
        <Input
          aria-label={searchLabel}
          placeholder={searchPlaceholder}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="w-64"
        />
      </div>
      <NativeSelect aria-label="Rows per page" value={String(pageSize)} onChange={(e) => onPageSize(Number(e.target.value))} className="w-28">
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n} rows
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Auto-refresh"
        value={String(autoRefreshSec)}
        onChange={(e) => onAutoRefresh(Number(e.target.value))}
        className="w-36"
      >
        {REFRESH_INTERVALS.map((n) => (
          <option key={n} value={n}>
            {n === 0 ? "No auto-refresh" : n < 60 ? `Every ${n}s` : `Every ${n / 60} min`}
          </option>
        ))}
      </NativeSelect>
      {autoRefreshSec > 0 && secondsLeft !== undefined && (
        <span className="font-mono text-xs text-ink-500" aria-live="off">
          {secondsLeft}s
        </span>
      )}
      {children}
      {selectedCount > 0 && (
        <span className="ml-auto flex items-center gap-2 rounded-md bg-ink-100 px-2 py-1 text-xs" role="group" aria-label="Selected rows">
          <span className="font-medium">{selectedCount} selected</span>
          {bulkActions.map((a) => (
            <Button
              key={a.label}
              variant="ghost"
              size="xs"
              className={a.tone === "danger" ? "text-danger-500 hover:text-danger-500" : ""}
              disabled={a.disabled}
              onClick={a.onClick}
            >
              {a.label}
            </Button>
          ))}
          {onClearSelection && (
            <Button variant="ghost" size="xs" onClick={onClearSelection}>
              Clear
            </Button>
          )}
        </span>
      )}
    </div>
  );
}
