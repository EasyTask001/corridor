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
    <div
      className="flex flex-wrap items-center gap-2 rounded-xl border border-border-default bg-surface-raised p-2 text-sm shadow-sm"
      role="toolbar"
      aria-label="List tools"
    >
      <div className="flex w-full min-w-0 items-center gap-1 sm:w-auto">
        {searchColumns && searchColumns.length > 0 && (
          <NativeSelect
            aria-label="Match on"
            value={searchColumn ?? ""}
            onChange={(e) => onSearchColumn?.(e.target.value)}
            className="w-32 shrink-0 sm:w-40"
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
          className="min-w-0 flex-1 sm:w-64"
        />
      </div>
      <NativeSelect
        aria-label="Rows per page"
        value={String(pageSize)}
        onChange={(e) => onPageSize(Number(e.target.value))}
        className="w-28"
      >
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
        <span className="font-mono text-xs text-fg-secondary" aria-live="off">
          {secondsLeft}s
        </span>
      )}
      {children}
      {selectedCount > 0 && (
        <span
          className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-surface-sunken px-2 py-1 text-xs sm:ml-auto sm:w-auto"
          role="group"
          aria-label="Selected rows"
        >
          <span className="font-medium">{selectedCount} selected</span>
          {bulkActions.map((a) => (
            <Button
              key={a.label}
              variant="ghost"
              size="xs"
              className={a.tone === "danger" ? "text-status-danger hover:text-status-danger" : ""}
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
