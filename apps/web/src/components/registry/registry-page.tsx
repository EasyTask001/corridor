"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { daysBetween, todayIso } from "@corridor/domain";
import {
  Badge,
  Button,
  Card,
  cn,
  createDataTableColumns,
  DataTable,
  Input,
  Label,
  NativeSelect,
  Textarea,
  type DataTableColumnDef,
} from "@corridor/ui";
import { useTRPC } from "@/lib/trpc/client";
import { REGISTRIES, type FieldDef, type RegistryConfig, type RegistryKind } from "./fields";

type Row = Record<string, unknown> & { id: string; status: string };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    cur = (cur[k] ??= {}) as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

function formToPayload(form: HTMLFormElement, fields: FieldDef[]) {
  const fd = new FormData(form);
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = String(fd.get(f.name) ?? "").trim();
    let v: unknown;
    if (raw === "") v = f.required ? "" : null;
    else if (f.type === "number") v = Number(raw);
    else v = f.uppercase ? raw.toUpperCase() : raw;
    setPath(out, f.name, v);
  }
  // Nested address: drop null leaves so the Zod object doesn't see nulls.
  if (out.address && typeof out.address === "object") {
    const a = out.address as Record<string, unknown>;
    for (const k of Object.keys(a)) if (a[k] === null) delete a[k];
  }
  return out;
}

export function ExpiryChip({ value }: { value: unknown }) {
  if (!value) return <span className="text-ink-300">—</span>;
  const iso = String(value).slice(0, 10);
  const days = daysBetween(todayIso(), iso);
  const cls =
    days < 0
      ? "bg-danger-500/10 text-danger-500"
      : days <= 14
        ? "bg-danger-500/10 text-danger-500"
        : days <= 60
          ? "bg-warn-500/10 text-warn-500"
          : "text-ink-700";
  const hint = days < 0 ? `${-days}d overdue` : days <= 60 ? `${days}d` : "";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-xs ${cls}`}
    >
      {iso}
      {hint && <span className="opacity-80">· {hint}</span>}
    </span>
  );
}

function StatusChip({ value }: { value: unknown }) {
  const s = String(value);
  return (
    <Badge variant={s === "active" ? "ok" : s === "inactive" ? "neutral" : "muted"}>{s}</Badge>
  );
}

/** Renders one registry cell from the column config (see `fields.ts`). */
function renderCell(cfg: RegistryConfig, r: Row, key: string): ReactNode {
  switch (key) {
    case "__name":
      return <span className="font-medium">{cfg.displayName(r)}</span>;
    case "__desc":
      return [r.modelYear, r.make, r.model].filter(Boolean).join(" ") || "—";
    case "__city": {
      const a = (r.address ?? {}) as Record<string, string>;
      return [a.city, a.region, a.country].filter(Boolean).join(", ") || "—";
    }
    default: {
      const col = cfg.columns.find((c) => c.key === key);
      const v = getPath(r, key);
      if (col?.kind === "expiry") return <ExpiryChip value={v} />;
      if (col?.kind === "status") return <StatusChip value={v} />;
      if (col?.kind === "mono")
        return <span className="font-mono text-xs">{String(v ?? "—")}</span>;
      return String(v ?? "—").replace(/_/g, " ");
    }
  }
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export function RegistryPage({ kind, canWrite }: { kind: RegistryKind; canWrite: boolean }) {
  const cfg = REGISTRIES[kind];
  const trpc = useTRPC();
  const qc = useQueryClient();
  // All four registries expose the same list/get/create/update/archive shape;
  // the input types differ per kind, so we go through a loosely-typed handle.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const procs = (trpc.party as any)[kind] as (typeof trpc.party)["drivers"];

  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listInput = useMemo(
    () => ({ search: search || undefined, includeArchived, limit: 100, offset: 0 }),
    [search, includeArchived],
  );
  const listOpts = procs.list.queryOptions(listInput);
  const { data, isLoading } = useQuery(listOpts);
  const rows = (data?.rows ?? []) as Row[];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: procs.list.queryKey() });
    qc.invalidateQueries({ queryKey: trpc.alerts.list.queryKey() });
    qc.invalidateQueries({ queryKey: trpc.alerts.summary.queryKey() });
  };
  const onError = (e: { message: string; data?: { zodError?: unknown } | null }) => {
    const z = e.data?.zodError as { fieldErrors?: Record<string, string[]> } | undefined;
    const first = z?.fieldErrors ? Object.entries(z.fieldErrors)[0] : undefined;
    setError(first ? `${first[0]}: ${first[1]?.[0]}` : e.message);
  };
  const create = useMutation(
    procs.create.mutationOptions({
      onSuccess: () => {
        setEditing(null);
        setError(null);
        invalidate();
      },
      onError,
    }),
  );
  const update = useMutation(
    procs.update.mutationOptions({
      onSuccess: () => {
        setEditing(null);
        setError(null);
        invalidate();
      },
      onError,
    }),
  );
  const archive = useMutation(procs.archive.mutationOptions({ onSuccess: invalidate }));

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const payload = formToPayload(e.currentTarget, cfg.fields);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (editing === "new") create.mutate(payload as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    else if (editing) update.mutate({ ...payload, id: editing.id } as any);
  };

  const columns = useMemo<DataTableColumnDef<Row>[]>(() => {
    const helper = createDataTableColumns<Row>();
    const cols: DataTableColumnDef<Row>[] = cfg.columns.map((c) =>
      helper.display({
        id: c.key,
        header: c.label,
        cell: ({ row }) => renderCell(cfg, row.original, c.key),
        meta: { className: "whitespace-nowrap", headerClassName: "whitespace-nowrap" },
      }),
    );
    if (canWrite) {
      cols.push(
        helper.display({
          id: "__actions",
          header: "",
          meta: { className: "whitespace-nowrap text-right" },
          cell: ({ row }) => (
            <>
              <Button
                variant="ghost"
                size="xs"
                className="mr-3 px-0 py-0"
                onClick={() => {
                  setError(null);
                  setEditing(row.original);
                }}
              >
                Edit
              </Button>
              {row.original.status !== "archived" && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="px-0 py-0 text-danger-500 hover:text-danger-500 hover:underline"
                  onClick={() => archive.mutate({ id: row.original.id })}
                >
                  Archive
                </Button>
              )}
            </>
          ),
        }),
      );
    }
    return cols;
  }, [cfg, canWrite, archive]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{cfg.title}</h1>
          <p className="text-sm text-ink-500">
            {data ? `${data.total} ${data.total === 1 ? "record" : "records"}` : " "}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Input
            aria-label="Search"
            placeholder={cfg.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-72"
          />
          <label className="flex items-center gap-1.5 text-xs text-ink-500">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Show archived
          </label>
          {canWrite && (
            <Button onClick={() => setEditing("new")}>New {cfg.singular.toLowerCase()}</Button>
          )}
        </div>
      </header>

      <Card className="overflow-x-auto">
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(r) => r.id}
          isLoading={isLoading}
          emptyMessage={`No ${cfg.title.toLowerCase()} yet.`}
          rowClassName={(r) => (r.status === "archived" ? "opacity-50" : undefined)}
        />
      </Card>

      {editing && (
        <div
          className="fixed inset-0 z-40 flex justify-end bg-ink-950/40"
          onClick={() => setEditing(null)}
        >
          <form
            role="dialog"
            aria-label={editing === "new" ? `New ${cfg.singular}` : `Edit ${cfg.singular}`}
            onClick={(e) => e.stopPropagation()}
            onSubmit={submit}
            className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-xl"
          >
            <div className="border-b border-ink-100 px-6 py-4">
              <h2 className="text-lg font-semibold">
                {editing === "new" ? `New ${cfg.singular.toLowerCase()}` : cfg.displayName(editing)}
              </h2>
            </div>
            <div className="grid flex-1 grid-cols-2 gap-4 px-6 py-5">
              {cfg.fields.map((f) => {
                const id = `${kind}-${f.name}`;
                const initial = editing === "new" ? "" : (getPath(editing, f.name) ?? "");
                const value =
                  f.type === "date" && initial ? String(initial).slice(0, 10) : String(initial);
                const cls = cn(f.mono && "font-mono", f.uppercase && "uppercase");
                return (
                  <div key={f.name} className={f.span === 2 ? "col-span-2" : ""}>
                    <Label htmlFor={id}>
                      {f.label}
                      {f.required && <span className="text-danger-500"> *</span>}
                    </Label>
                    {f.type === "select" ? (
                      <NativeSelect
                        id={id}
                        name={f.name}
                        defaultValue={value || f.options?.[0]?.value}
                        className={cls}
                      >
                        {f.options?.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : f.type === "textarea" ? (
                      <Textarea
                        id={id}
                        name={f.name}
                        defaultValue={value}
                        rows={3}
                        className={cls}
                      />
                    ) : (
                      <Input
                        id={id}
                        name={f.name}
                        type={f.type ?? "text"}
                        defaultValue={value}
                        required={f.required}
                        placeholder={f.placeholder}
                        className={cls}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-ink-100 px-6 py-4">
              <p className="text-sm text-danger-500">{error}</p>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={create.isPending || update.isPending}>
                  {create.isPending || update.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
