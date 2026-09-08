"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EQUIPMENT_TYPE_LABELS,
  REGISTRY_SEARCH_COLUMNS,
  daysBetween,
  todayIso,
  type EquipmentType,
} from "@corridor/domain";
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
import { RecordHistoryDialog } from "@/components/record-history";
import { ColumnChooser } from "@/components/list/column-chooser";
import { ListToolbar } from "@/components/list/list-toolbar";
import { useAutoRefresh } from "@/components/list/use-auto-refresh";
import { useListPrefs } from "@/components/list/use-list-prefs";
import { DriverDocumentsPanel } from "./driver-documents-panel";
import { REGISTRIES, type FieldDef, type RegistryConfig, type RegistryKind } from "./fields";

type Row = Record<string, unknown> & { id: string; status: string };

const ENTITY_OF: Record<RegistryKind, "driver" | "truck" | "trailer" | "partner"> = {
  drivers: "driver",
  trucks: "truck",
  trailers: "trailer",
  partners: "partner",
};

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

function scalarValue(fd: FormData, name: string, f: FieldDef): unknown {
  const raw = String(fd.get(name) ?? "").trim();
  if (raw === "") return f.required ? "" : null;
  if (f.type === "number") return Number(raw);
  if (f.type === "boolean") return raw === "true";
  return f.uppercase ? raw.toUpperCase() : raw;
}

function formToPayload(form: HTMLFormElement, fields: FieldDef[]) {
  const fd = new FormData(form);
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === "repeater") {
      // Rows are named `<field>.<n>.<sub>`; a row with every sub-field blank
      // is an unused slot, not a validation error.
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < (f.max ?? 10); i++) {
        if (!fd.has(`${f.name}.${i}.${f.fields?.[0]?.name}`)) continue;
        const row: Record<string, unknown> = {};
        for (const sub of f.fields ?? []) row[sub.name] = scalarValue(fd, `${f.name}.${i}.${sub.name}`, sub);
        if (Object.values(row).some((v) => v !== null && v !== "")) rows.push(row);
      }
      out[f.name] = rows;
      continue;
    }
    setPath(out, f.name, scalarValue(fd, f.name, f));
  }
  // Nested addresses (partners.address, drivers.usAddress): drop null leaves so
  // the Zod object doesn't see nulls.
  for (const value of Object.values(out)) {
    if (!value || typeof value !== "object") continue;
    const nested = value as Record<string, unknown>;
    for (const k of Object.keys(nested)) if (nested[k] === null) delete nested[k];
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
      if (col?.kind === "equipmentType")
        return (
          <span>
            <span className="font-mono text-xs">{String(v ?? "")}</span>
            <span className="ml-1.5 text-xs text-ink-500">
              {EQUIPMENT_TYPE_LABELS[v as EquipmentType] ?? ""}
            </span>
          </span>
        );
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
  const [searchColumn, setSearchColumn] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const columnKeys = useMemo(() => cfg.columns.map((c) => c.key), [cfg]);
  const prefDefaults = useMemo(() => ({ columns: columnKeys, pageSize: 25, autoRefreshSec: 0 }), [columnKeys]);
  const [prefs, setPrefs] = useListPrefs(kind, prefDefaults, columnKeys);
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  /** Drivers get a second tab; every other registry only has its fields. */
  const [tab, setTab] = useState<"details" | "documents">("details");
  const [error, setError] = useState<string | null>(null);

  const listInput = useMemo(
    () => ({
      search: search || undefined,
      searchColumn: search && searchColumn ? searchColumn : undefined,
      includeArchived,
      pageSize: prefs.pageSize,
      limit: prefs.pageSize,
      offset: page * prefs.pageSize,
    }),
    [search, searchColumn, includeArchived, prefs.pageSize, page],
  );
  const listOpts = procs.list.queryOptions(listInput);
  const { data, isLoading, refetch } = useQuery(listOpts);
  const { secondsLeft } = useAutoRefresh(prefs.autoRefreshSec, () => refetch());
  const rows = useMemo(() => (data?.rows ?? []) as Row[], [data]);
  // Runtime option lists (the CBP equipment codes) — fetched once per registry
  // that declares a field needing them.
  const needsEquipmentTypes = cfg.fields.some((f) => f.optionsFrom === "equipmentTypes");
  const equipmentTypes = useQuery({
    ...trpc.reference.equipmentTypes.list.queryOptions(),
    enabled: needsEquipmentTypes,
    staleTime: 5 * 60_000,
  });
  const optionsFor = (f: FieldDef) =>
    f.optionsFrom === "equipmentTypes"
      ? (equipmentTypes.data ?? []).map((t) => ({ value: t.code, label: `${t.code} · ${t.label}` }))
      : (f.options ?? []);

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
  const bulkStatus = useMutation(
    procs.bulkSetStatus.mutationOptions({
      onSuccess: () => {
        setSelected(new Set());
        invalidate();
      },
      onError,
    }),
  );
  const [exportUrl, setExportUrl] = useState<{ url: string; format: string } | null>(null);
  const exportList = useMutation(
    procs.export.mutationOptions({
      onSuccess: (r) => setExportUrl({ url: r.signedUrl, format: r.format }),
      onError,
    }),
  );

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
    const cols: DataTableColumnDef<Row>[] = cfg.columns
      .filter((c) => prefs.columns.includes(c.key))
      .map((c) =>
        helper.display({
          id: c.key,
          header: c.label,
          cell: ({ row }) => renderCell(cfg, row.original, c.key),
          meta: { className: "whitespace-nowrap", headerClassName: "whitespace-nowrap" },
        }),
      );
    if (canWrite) {
      const pageIds = rows.map((r) => r.id);
      const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
      cols.unshift(
        helper.display({
          id: "__select",
          header: () => (
            <input
              type="checkbox"
              aria-label="Select all on this page"
              checked={allOnPage}
              onChange={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (allOnPage) pageIds.forEach((id) => next.delete(id));
                  else pageIds.forEach((id) => next.add(id));
                  return next;
                })
              }
            />
          ),
          meta: { className: "w-8" },
          cell: ({ row }) => (
            <input
              type="checkbox"
              aria-label={`Select ${cfg.displayName(row.original)}`}
              checked={selected.has(row.original.id)}
              onChange={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.original.id)) next.delete(row.original.id);
                  else next.add(row.original.id);
                  return next;
                })
              }
            />
          ),
        }),
      );
    }
    cols.push(
      helper.display({
        id: "__actions",
        header: "",
        meta: { className: "whitespace-nowrap text-right" },
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-3">
            <RecordHistoryDialog
              entityType={ENTITY_OF[cfg.kind]}
              entityId={row.original.id}
              label={cfg.displayName(row.original)}
            />
            {canWrite && (
              <>
                <Button
                variant="ghost"
                size="xs"
                className="mr-3 px-0 py-0"
                onClick={() => {
                  setError(null);
                  setTab("details");
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
            )}
          </span>
        ),
      }),
    );
    return cols;
  }, [cfg, canWrite, archive, prefs.columns, rows, selected]);

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
          <span className="flex items-center gap-1 text-xs">
            {(["csv", "pdf"] as const).map((format) => (
              <Button
                key={format}
                variant="ghost"
                size="xs"
                disabled={exportList.isPending}
                onClick={() => exportList.mutate({ format, includeArchived })}
              >
                Export {format.toUpperCase()}
              </Button>
            ))}
            {exportUrl && (
              <a
                href={exportUrl.url}
                target="_blank"
                rel="noopener"
                data-testid="registry-export-link"
                className="font-medium text-ink-950 underline underline-offset-2"
              >
                Download {exportUrl.format.toUpperCase()}
              </a>
            )}
          </span>
          {canWrite && (
            <Button
              onClick={() => {
                setTab("details");
                setEditing("new");
              }}
            >
              New {cfg.singular.toLowerCase()}
            </Button>
          )}
        </div>
      </header>

      <ListToolbar
        search={search}
        onSearch={(v) => {
          setSearch(v);
          setPage(0);
        }}
        searchPlaceholder={cfg.searchPlaceholder}
        searchColumns={REGISTRY_SEARCH_COLUMNS[kind]}
        searchColumn={searchColumn}
        onSearchColumn={(v) => {
          setSearchColumn(v);
          setPage(0);
        }}
        pageSize={prefs.pageSize}
        onPageSize={(n) => {
          setPrefs({ pageSize: n });
          setPage(0);
        }}
        autoRefreshSec={prefs.autoRefreshSec}
        onAutoRefresh={(n) => setPrefs({ autoRefreshSec: n })}
        secondsLeft={secondsLeft}
        selectedCount={selected.size}
        onClearSelection={() => setSelected(new Set())}
        bulkActions={
          canWrite
            ? [
                { label: "Activate selected", onClick: () => bulkStatus.mutate({ ids: [...selected], status: "active" }), disabled: bulkStatus.isPending },
                { label: "Deactivate selected", onClick: () => bulkStatus.mutate({ ids: [...selected], status: "inactive" }), disabled: bulkStatus.isPending },
                { label: "Archive selected", tone: "danger", onClick: () => bulkStatus.mutate({ ids: [...selected], status: "archived" }), disabled: bulkStatus.isPending },
              ]
            : []
        }
      >
        <label className="flex items-center gap-1.5 text-xs text-ink-500">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => {
              setIncludeArchived(e.target.checked);
              setPage(0);
            }}
          />
          Show archived
        </label>
        <ColumnChooser columns={cfg.columns} selected={prefs.columns} defaults={columnKeys} onChange={(cols) => setPrefs({ columns: cols })} />
      </ListToolbar>

      <Card className="overflow-x-auto">
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(r) => r.id}
          isLoading={isLoading}
          emptyMessage={`No ${cfg.title.toLowerCase()} yet.`}
          rowClassName={(r) => (r.status === "archived" ? "opacity-50" : undefined)}
          pageIndex={page}
          pageSize={prefs.pageSize}
          total={data?.total}
          onPageChange={setPage}
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
              {/* Travel documents hang off a saved driver, so the tab only
                  appears once there is a driver id to hang them on. */}
              {kind === "drivers" && editing !== "new" && (
                <div className="mt-3 flex gap-4 text-sm">
                  {(["details", "documents"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTab(t)}
                      className={cn(
                        "border-b-2 pb-1",
                        tab === t
                          ? "border-ink-900 font-medium"
                          : "border-transparent text-ink-500",
                      )}
                    >
                      {t === "details" ? "Details" : "Travel documents"}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {kind === "drivers" && editing !== "new" && tab === "documents" ? (
              <div className="flex-1 px-6 py-5">
                <DriverDocumentsPanel driverId={editing.id} canWrite={canWrite} />
              </div>
            ) : (
            <div className="grid flex-1 grid-cols-2 gap-4 px-6 py-5">
              {cfg.fields.map((f) => {
                const id = `${kind}-${f.name}`;
                const initial = editing === "new" ? "" : (getPath(editing, f.name) ?? "");
                if (f.type === "repeater") {
                  return (
                    <Repeater
                      key={f.name}
                      idPrefix={id}
                      field={f}
                      initial={
                        Array.isArray(initial) ? (initial as Record<string, unknown>[]) : []
                      }
                    />
                  );
                }
                const value =
                  f.type === "date" && initial ? String(initial).slice(0, 10) : String(initial);
                const cls = cn(f.mono && "font-mono", f.uppercase && "uppercase");
                const options = optionsFor(f);
                return (
                  <div key={f.name} className={f.span === 2 ? "col-span-2" : ""}>
                    <Label htmlFor={id}>
                      {f.label}
                      {f.required && <span className="text-danger-500"> *</span>}
                    </Label>
                    {f.type === "select" || f.type === "boolean" ? (
                      <NativeSelect
                        id={id}
                        name={f.name}
                        defaultValue={value || options[0]?.value}
                        className={cls}
                      >
                        {options.map((o) => (
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
            )}
            <div className="flex items-center justify-between gap-3 border-t border-ink-100 px-6 py-4">
              <p className="text-sm text-danger-500">{error}</p>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                  {tab === "documents" ? "Close" : "Cancel"}
                </Button>
                {tab === "details" && (
                  <Button type="submit" disabled={create.isPending || update.isPending}>
                    {create.isPending || update.isPending ? "Saving…" : "Save"}
                  </Button>
                )}
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

/**
 * An ordered list of small sub-rows inside the registry form (extra plates).
 * Rows are uncontrolled inputs named `<field>.<n>.<sub>` so `formToPayload`
 * can gather them from the surrounding <form>; only the row count is state.
 */
function Repeater({
  idPrefix,
  field: f,
  initial,
}: {
  idPrefix: string;
  field: FieldDef;
  initial: Record<string, unknown>[];
}) {
  const max = f.max ?? 10;
  const [count, setCount] = useState(initial.length);
  const rows = Array.from({ length: count }, (_, i) => initial[i] ?? {});
  return (
    <fieldset className={f.span === 2 ? "col-span-2" : ""}>
      <legend className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-500">
        {f.label}
        <span className="ml-1.5 font-normal normal-case tracking-normal text-ink-300">
          {count}/{max}
        </span>
      </legend>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-end gap-2">
            {(f.fields ?? []).map((sub) => {
              const name = `${f.name}.${i}.${sub.name}`;
              const id = `${idPrefix}-${i}-${sub.name}`;
              return (
                <div key={sub.name} className="flex-1">
                  <Label htmlFor={id} className="text-[10px]">
                    {sub.label}
                  </Label>
                  <Input
                    id={id}
                    name={name}
                    defaultValue={String(row[sub.name] ?? "")}
                    placeholder={sub.placeholder}
                    required={sub.required}
                    className={cn(sub.mono && "font-mono", sub.uppercase && "uppercase")}
                  />
                </div>
              );
            })}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Remove ${f.label.toLowerCase()} ${i + 1}`}
              className="mb-1.5 px-1 text-danger-500 hover:text-danger-500"
              onClick={() => setCount((c) => c - 1)}
            >
              Remove
            </Button>
          </div>
        ))}
        {count < max && (
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => setCount((c) => c + 1)}
          >
            {f.addLabel ?? "Add row"}
          </Button>
        )}
      </div>
    </fieldset>
  );
}
