"use client";

/** Live widgets: the wait at a chosen port, and a tariff search, both from the mock-or-cached feeds. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input, Label } from "@corridor/ui";
import { PortPicker } from "@/components/port-picker";
import { useTRPC } from "@/lib/trpc/client";

export function ResourcesPanel() {
  const trpc = useTRPC();
  const [portId, setPortId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const wait = useQuery(
    trpc.reference.borderWait.queryOptions(
      { portId: portId ?? "" },
      { enabled: !!portId, refetchInterval: 5 * 60_000 },
    ),
  );
  const tariff = useQuery(
    trpc.reference.tariffSearch.queryOptions({ q }, { enabled: q.trim().length >= 2 }),
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="panel space-y-3 p-5" aria-label="Border wait">
        <h2 className="font-medium">Border wait at a port</h2>
        <div>
          <Label htmlFor="waitPort">Port or office</Label>
          <PortPicker id="waitPort" onSelect={(p) => setPortId(p?.id ?? null)} />
        </div>
        {wait.data && (
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2" aria-live="polite">
            <dt className="text-fg-secondary">Port</dt>
            <dd className="font-mono">
              {wait.data.port.code} {wait.data.port.name}
            </dd>
            <dt className="text-fg-secondary">Commercial lanes</dt>
            <dd data-testid="border-wait-minutes">{wait.data.wait.lanes.commercial} min</dd>
            <dt className="text-fg-secondary">FAST lanes</dt>
            <dd>{wait.data.wait.lanes.fast} min</dd>
            <dt className="text-fg-secondary">Updated</dt>
            <dd className="text-xs text-fg-secondary">
              {new Date(wait.data.wait.updatedAt).toLocaleTimeString("en-CA")}
            </dd>
          </dl>
        )}
        {portId && wait.isLoading && <p className="text-sm text-fg-secondary">Checking…</p>}
        {!portId && (
          <p className="text-sm text-fg-secondary">
            Pick a port to see the current wait. Refreshes every five minutes.
          </p>
        )}
      </section>
      <section className="panel space-y-3 p-5" aria-label="Tariff search">
        <h2 className="font-medium">HTS / tariff search</h2>
        <div>
          <Label htmlFor="tariffQ">Description or code</Label>
          <Input
            id="tariffQ"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="steel coil, 7208…"
          />
        </div>
        <ul className="divide-y divide-border-default text-sm" aria-label="Tariff results">
          {tariff.data?.map((t) => (
            <li key={t.hsCode} className="flex gap-3 py-1.5">
              <span className="w-24 shrink-0 font-mono text-xs">{t.hsCode}</span>
              <span className="min-w-0 flex-1 truncate">{t.description}</span>
            </li>
          ))}
          {tariff.data?.length === 0 && <li className="py-1.5 text-fg-secondary">No matches.</li>}
        </ul>
      </section>
    </div>
  );
}
