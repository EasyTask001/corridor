"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PortKind, Regime } from "@corridor/domain";
import { useTRPC } from "@/lib/trpc/client";

export interface PickablePort {
  id: string;
  code: string;
  name: string;
  stateProvince: string | null;
}

const labelOf = (v: { code: string; name?: string | null } | null | undefined) =>
  v ? `${v.code}${v.name ? ` — ${v.name}` : ""}` : "";

/**
 * Debounced search over `reference.ports.search`; renders "code — name (state)".
 *
 * Uncontrolled by design: `value` only seeds the initial display text. If the
 * caller's selected port can change from outside `onSelect` (e.g. a form
 * reset), remount with a fresh `key` rather than relying on this to re-sync —
 * syncing prop changes into state via an effect is the anti-pattern React's
 * lint rule (and its own docs) warn against.
 */
export function PortPicker({
  id,
  regime,
  kind = "port_of_entry",
  value,
  onSelect,
  placeholder = "Search port or office…",
  disabled,
}: {
  id?: string;
  regime?: Regime;
  kind?: PortKind;
  value?: { code: string; name?: string | null } | null;
  onSelect: (port: PickablePort | null) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const trpc = useTRPC();
  const [query, setQuery] = useState(() => labelOf(value));
  const [debounced, setDebounced] = useState(query);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const results = useQuery({
    ...trpc.reference.ports.search.queryOptions({ regime, kind, q: debounced, limit: 20 }),
    enabled: open && debounced.trim().length > 0,
  });

  return (
    <div className="relative">
      <input
        id={id}
        className="input"
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          if (e.target.value.trim() === "") onSelect(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (results.data?.length ?? 0) > 0 && (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border-default bg-surface-raised text-sm shadow-lg">
          {results.data!.map((port) => (
            <li key={port.id}>
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left hover:bg-surface-sunken"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery(labelOf(port));
                  setOpen(false);
                  onSelect(port);
                }}
              >
                <span className="font-mono">{port.code}</span> — {port.name}
                {port.stateProvince ? ` (${port.stateProvince})` : ""}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
