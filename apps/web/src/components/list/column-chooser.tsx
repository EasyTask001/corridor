"use client";

/** Task 12's column picker, bound to a list's remembered preferences. */
import { ColumnPicker } from "@/components/reports/column-picker";

export function ColumnChooser<K extends string>({
  columns,
  selected,
  defaults,
  onChange,
}: {
  columns: ReadonlyArray<{ key: K; label: string }>;
  selected: K[];
  defaults: K[];
  onChange: (next: K[]) => void;
}) {
  return <ColumnPicker columns={columns} selected={selected} defaults={defaults} onChange={onChange} />;
}
