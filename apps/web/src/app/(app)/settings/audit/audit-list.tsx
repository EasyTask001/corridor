"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { useTRPC } from "@/lib/trpc/client";

type AuditResult = inferRouterOutputs<AppRouter>["audit"]["list"];

export function AuditList({ initial }: { initial: AuditResult }) {
  const trpc = useTRPC();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const options = trpc.audit.list.queryOptions({ search: search || undefined, limit: 100 });
  const { data = initial, isFetching } = useQuery({
    ...options,
    initialData: search ? undefined : initial,
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearch(draft.trim());
  };

  return (
    <div className="space-y-4">
      <form className="panel flex gap-3 p-4" onSubmit={submit}>
        <div className="max-w-xl flex-1">
          <label className="label" htmlFor="audit-search">
            Search actions or entities
          </label>
          <input
            id="audit-search"
            className="input"
            value={draft}
            maxLength={100}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="role.update, movement, driver…"
          />
        </div>
        <button className="btn-secondary self-end" disabled={isFetching}>
          {isFetching ? "Searching…" : "Search"}
        </button>
      </form>

      <div className="panel overflow-x-auto">
        <div className="border-b border-ink-100 px-4 py-3 text-xs text-ink-500">
          Showing {data.rows.length} of {data.total} events
        </div>
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">Actor</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Entity</th>
              <th className="px-4 py-2 font-medium">Changes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {data.rows.map((entry) => (
              <tr key={entry.id}>
                <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                  {entry.createdAt.toLocaleString("en-CA")}
                </td>
                <td className="px-4 py-2">
                  {entry.actorName ?? (entry.actorId ? entry.actorId.slice(0, 8) : "System")}
                </td>
                <td className="px-4 py-2 font-mono text-xs">{entry.action}</td>
                <td className="px-4 py-2">
                  <span>{entry.entityType}</span>
                  {entry.entityId && (
                    <span className="ml-2 font-mono text-xs text-ink-500">
                      {entry.entityId.slice(0, 12)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {entry.before || entry.after ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-ink-500">View</summary>
                      <pre className="mt-2 max-w-lg overflow-auto rounded bg-ink-950 p-3 text-xs text-ink-100">
                        {JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}
                      </pre>
                    </details>
                  ) : (
                    <span className="text-ink-500">—</span>
                  )}
                </td>
              </tr>
            ))}
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-ink-500">
                  No audit events match this search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
