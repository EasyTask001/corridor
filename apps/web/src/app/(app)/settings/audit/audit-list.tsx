"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import {
  Button,
  Card,
  createDataTableColumns,
  DataTable,
  Input,
  Label,
  type DataTableColumnDef,
} from "@corridor/ui";
import { useTRPC } from "@/lib/trpc/client";

type AuditResult = inferRouterOutputs<AppRouter>["audit"]["list"];
type AuditEntry = AuditResult["rows"][number];

const auditColumns: DataTableColumnDef<AuditEntry>[] = (() => {
  const helper = createDataTableColumns<AuditEntry>();
  return helper.columns([
    helper.accessor((entry) => entry.createdAt.getTime(), {
      id: "time",
      header: "Time",
      cell: ({ row }) => row.original.createdAt.toLocaleString("en-CA"),
      meta: { className: "whitespace-nowrap text-xs text-fg-secondary" },
    }),
    helper.accessor(
      (entry) => entry.actorName ?? (entry.actorId ? entry.actorId.slice(0, 8) : "System"),
      { id: "actor", header: "Actor" },
    ),
    helper.accessor("action", {
      id: "action",
      header: "Action",
      meta: { className: "font-mono text-xs" },
    }),
    helper.accessor("entityType", {
      id: "entity",
      header: "Entity",
      cell: ({ row }) => (
        <>
          <span>{row.original.entityType}</span>
          {row.original.entityId && (
            <span className="ml-2 font-mono text-xs text-fg-secondary">
              {row.original.entityId.slice(0, 12)}
            </span>
          )}
        </>
      ),
    }),
    helper.display({
      id: "changes",
      header: "Changes",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.before || row.original.after ? (
          <details>
            <summary className="cursor-pointer text-xs text-fg-secondary">View</summary>
            <pre className="mt-2 max-w-lg overflow-auto rounded bg-ink-950 p-3 text-xs text-ink-100">
              {JSON.stringify({ before: row.original.before, after: row.original.after }, null, 2)}
            </pre>
          </details>
        ) : (
          <span className="text-fg-secondary">—</span>
        ),
    }),
  ]);
})();

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
          <Label htmlFor="audit-search">Search actions or entities</Label>
          <Input
            id="audit-search"
            value={draft}
            maxLength={100}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="role.update, movement, driver…"
          />
        </div>
        <Button variant="secondary" className="self-end" disabled={isFetching}>
          {isFetching ? "Searching…" : "Search"}
        </Button>
      </form>

      <Card className="overflow-x-auto">
        <div className="border-b border-border-default px-4 py-3 text-xs text-fg-secondary">
          Showing {data.rows.length} of {data.total} events
        </div>
        <DataTable
          data={data.rows}
          columns={auditColumns}
          getRowId={(entry) => String(entry.id)}
          enableSorting
          emptyMessage="No audit events match this search."
        />
      </Card>
    </div>
  );
}
