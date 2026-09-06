"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { daysBetween, todayIso } from "@corridor/domain";
import { useTRPC } from "@/lib/trpc/client";
import { REGISTRIES, type FieldDef, type RegistryKind } from "./fields";

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
  const cls =
    s === "active"
      ? "bg-ok-500/10 text-ok-500"
      : s === "inactive"
        ? "bg-ink-100 text-ink-500"
        : "bg-ink-100 text-ink-300";
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{s}</span>;
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

  const cell = (r: Row, key: string) => {
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
  };

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
          <input
            aria-label="Search"
            placeholder={cfg.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input w-72"
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
            <button className="btn-primary" onClick={() => setEditing("new")}>
              New {cfg.singular.toLowerCase()}
            </button>
          )}
        </div>
      </header>

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              {cfg.columns.map((c) => (
                <th key={c.key} className="whitespace-nowrap px-4 py-2 font-medium">
                  {c.label}
                </th>
              ))}
              {canWrite && <th className="px-4 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {isLoading && (
              <tr>
                <td className="px-4 py-6 text-ink-500" colSpan={cfg.columns.length + 1}>
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-ink-500" colSpan={cfg.columns.length + 1}>
                  No {cfg.title.toLowerCase()} yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className={r.status === "archived" ? "opacity-50" : ""}>
                {cfg.columns.map((c) => (
                  <td key={c.key} className="whitespace-nowrap px-4 py-2">
                    {cell(r, c.key)}
                  </td>
                ))}
                {canWrite && (
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <button
                      className="mr-3 text-xs text-ink-500 hover:text-ink-950"
                      onClick={() => {
                        setError(null);
                        setEditing(r);
                      }}
                    >
                      Edit
                    </button>
                    {r.status !== "archived" && (
                      <button
                        className="text-xs text-danger-500 hover:underline"
                        onClick={() => archive.mutate({ id: r.id })}
                      >
                        Archive
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
                const cls = `input ${f.mono ? "font-mono" : ""} ${f.uppercase ? "uppercase" : ""}`;
                return (
                  <div key={f.name} className={f.span === 2 ? "col-span-2" : ""}>
                    <label htmlFor={id} className="label">
                      {f.label}
                      {f.required && <span className="text-danger-500"> *</span>}
                    </label>
                    {f.type === "select" ? (
                      <select
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
                      </select>
                    ) : f.type === "textarea" ? (
                      <textarea
                        id={id}
                        name={f.name}
                        defaultValue={value}
                        rows={3}
                        className={cls}
                      />
                    ) : (
                      <input
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
                <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={create.isPending || update.isPending}
                >
                  {create.isPending || update.isPending ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
