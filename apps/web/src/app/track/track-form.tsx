"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TrackingResult } from "@corridor/domain";
import { useTRPC } from "@/lib/trpc/client";

const STATUS_LABEL: Record<string, string> = {
  draft: "Not yet filed",
  sent: "Sent to customs",
  accepted: "Accepted by customs",
  entry_on_file: "Entry on file",
  released: "Released",
  held: "Held for inspection",
  rejected: "Rejected",
  arrived: "Arrived",
  cancelled: "Cancelled",
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "—";

export function TrackForm() {
  const trpc = useTRPC();
  const [input, setInput] = useState<{ carrierCode: string; controlNumber: string } | null>(null);
  // One lookup per submit: the query is enabled once there is an input, and a
  // repeated identical submit refetches rather than reading the cache.
  const lookup = useQuery({
    ...trpc.tracking.lookup.queryOptions(input ?? { carrierCode: "XX", controlNumber: "XXXXXX" }),
    enabled: !!input,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const result: TrackingResult | null = lookup.data ?? null;
  const error = lookup.error?.message ?? null;

  return (
    <div className="space-y-4">
      <form
        className="panel grid grid-cols-1 gap-3 p-5 sm:grid-cols-[8rem_1fr]"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const next = {
            carrierCode: String(fd.get("carrierCode") ?? "")
              .trim()
              .toUpperCase(),
            controlNumber: String(fd.get("controlNumber") ?? "")
              .replace(/\s+/g, "")
              .toUpperCase(),
          };
          if (
            input &&
            input.carrierCode === next.carrierCode &&
            input.controlNumber === next.controlNumber
          ) {
            void lookup.refetch();
          } else {
            setInput(next);
          }
        }}
      >
        <div>
          <label htmlFor="carrierCode" className="label">
            Carrier code
          </label>
          <input
            id="carrierCode"
            name="carrierCode"
            required
            maxLength={4}
            className="input font-mono uppercase"
            placeholder="PFTR"
          />
        </div>
        <div>
          <label htmlFor="controlNumber" className="label">
            PAPS / PARS control number
          </label>
          <input
            id="controlNumber"
            name="controlNumber"
            required
            maxLength={24}
            className="input font-mono uppercase"
            placeholder="PFTRPAPS90001"
          />
        </div>
        <div className="sm:col-span-2">
          <button className="btn-primary w-full sm:w-auto" disabled={lookup.isFetching}>
            {lookup.isFetching ? "Checking…" : "Check status"}
          </button>
        </div>
      </form>
      {error && (
        <p
          role="alert"
          className="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-status-danger"
        >
          {error}
        </p>
      )}
      {result && !result.found && !lookup.isFetching && (
        <p className="panel px-4 py-3 text-sm text-fg-primary" role="status">
          No filing matches that carrier code and control number.
        </p>
      )}
      {result?.found && !lookup.isFetching && (
        <dl
          className="panel grid grid-cols-1 gap-x-6 gap-y-3 p-5 text-sm sm:grid-cols-2"
          aria-label="Shipment status"
        >
          <div className="sm:col-span-2">
            <dt className="text-xs uppercase tracking-wide text-fg-secondary">Status</dt>
            <dd className="text-lg font-semibold">
              {STATUS_LABEL[result.status] ?? result.status}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-fg-secondary">Port</dt>
            <dd className="font-mono">
              {result.portCode ? `${result.portCode} ${result.portName ?? ""}` : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-fg-secondary">Entry number</dt>
            <dd className="font-mono">{result.entryNumber ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-fg-secondary">Last update</dt>
            <dd>{fmt(result.updatedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-fg-secondary">Released</dt>
            <dd>{fmt(result.releasedAt)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
