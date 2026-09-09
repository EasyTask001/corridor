"use client";

/**
 * A checklist of report columns in a disclosure, with select-all and a
 * reset to the report's defaults. The caller owns the selection and its
 * persistence; this only renders and edits it.
 */
import { Button } from "@corridor/ui";

export function ColumnPicker<K extends string>({
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
  const toggle = (key: K, on: boolean) => {
    const next = on ? [...selected, key] : selected.filter((k) => k !== key);
    // Keep the canonical column order rather than click order.
    onChange(columns.map((c) => c.key).filter((k) => next.includes(k)));
  };
  return (
    <details className="relative text-sm">
      <summary className="cursor-pointer select-none rounded-md border border-border-default bg-surface-raised px-3 py-2 text-fg-primary hover:bg-surface-sunken">
        Columns ({selected.length} of {columns.length})
      </summary>
      <div
        className="absolute right-0 z-20 mt-1 w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-border-default bg-surface-overlay p-3 shadow-lg"
        role="group"
        aria-label="Report columns"
      >
        <div className="mb-2 flex items-center justify-between text-xs">
          <Button
            variant="link"
            size="xs"
            className="px-0"
            onClick={() => onChange(columns.map((c) => c.key))}
          >
            Select all
          </Button>
          <Button variant="link" size="xs" className="px-0" onClick={() => onChange(defaults)}>
            Defaults
          </Button>
        </div>
        <ul className="max-h-72 space-y-1 overflow-auto">
          {columns.map((c) => (
            <li key={c.key}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(c.key)}
                  onChange={(e) => toggle(c.key, e.target.checked)}
                  disabled={selected.length === 1 && selected.includes(c.key)}
                />
                {c.label}
              </label>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
