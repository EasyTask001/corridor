"use client";

/**
 * CSV import in three steps: pick a file (read in the browser), validate
 * (every line gets a verdict), commit only the ok lines. Committed batches
 * can be deleted again while their rows are still drafts.
 */
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import type { ImportKind } from "@corridor/domain";
import { Badge, Button, fieldClassName, Label, NativeSelect } from "@corridor/ui";
import { useTRPC } from "@/lib/trpc/client";

type Outputs = inferRouterOutputs<AppRouter>["imports"];
type Batches = Outputs["list"];
type Template = Outputs["template"];
type Validation = Outputs["validate"];

const KIND_LABEL: Record<ImportKind, string> = { shipments: "Shipments", commodities: "Commodity lines" };
const when = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function ImportWizard({
  canRun,
  initialBatches,
  templates,
}: {
  canRun: boolean;
  initialBatches: Batches;
  templates: Record<ImportKind, Template>;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const listOpts = trpc.imports.list.queryOptions({ limit: 20, offset: 0 });
  const { data: batches } = useQuery({ ...listOpts, initialData: initialBatches });
  const [kind, setKind] = useState<ImportKind>("shipments");
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [validation, setValidation] = useState<(Validation & { filename: string }) | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: listOpts.queryKey });
    void qc.invalidateQueries({ queryKey: trpc.shipment.pathKey() });
  };
  const validate = useMutation(
    trpc.imports.validate.mutationOptions({
      onSuccess: (r, vars) => {
        setError(null);
        setNotice(null);
        setValidation({ ...r, filename: vars.filename });
        invalidate();
      },
      onError: (e) => setError(e.message),
    }),
  );
  const commit = useMutation(
    trpc.imports.commit.mutationOptions({
      onSuccess: (r) => {
        setError(null);
        setNotice(`Committed ${plural(r.inserted, "row")}.`);
        setValidation(null);
        setFile(null);
        invalidate();
      },
      onError: (e) => setError(e.message),
    }),
  );
  const remove = useMutation(
    trpc.imports.deleteBatch.mutationOptions({
      onSuccess: (r) => {
        setError(null);
        setNotice(
          r.kept.length
            ? `Deleted ${plural(r.deleted, "row")}; kept ${r.kept.length} already filed: ${r.kept.join(", ")}.`
            : `Deleted ${plural(r.deleted, "row")}.`,
        );
        invalidate();
      },
      onError: (e) => setError(e.message),
    }),
  );

  const template = templates[kind];
  const headerHref = `data:text/csv;charset=utf-8,${encodeURIComponent(`${template.header}\n`)}`;
  const okCount = validation?.report.okCount ?? 0;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Import from CSV</h1>
          <p className="text-sm text-ink-500">
            Shipments, or commodity lines for shipments that already exist. Every line is checked
            first; only the lines that pass are written.
          </p>
        </div>
        <Link href="/shipments" className="text-sm text-ink-500 hover:underline">
          Back to shipments
        </Link>
      </header>

      {error && (
        <p role="alert" className="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-danger-500">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-md bg-ok-500/10 px-3 py-2 text-sm text-ok-500">
          {notice}
        </p>
      )}

      {canRun && (
        <section className="panel space-y-4 p-5" aria-label="Import file">
          <div className="grid gap-4 sm:grid-cols-[14rem_1fr_auto]">
            <div>
              <Label htmlFor="importKind">What the file holds</Label>
              <NativeSelect id="importKind" value={kind} onChange={(e) => setKind(e.target.value as ImportKind)}>
                <option value="shipments">Shipments (ACE and/or ACI)</option>
                <option value="commodities">Commodity lines</option>
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="importFile">CSV / TXT / DAT file</Label>
              <input
                id="importFile"
                type="file"
                accept=".csv,.txt,.dat,text/csv,text/plain"
                className={fieldClassName}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return setFile(null);
                  void f.text().then((content) => setFile({ name: f.name, content }));
                }}
              />
            </div>
            <div className="flex items-end">
              <Button
                disabled={!file || validate.isPending}
                onClick={() => file && validate.mutate({ kind, filename: file.name, content: file.content })}
              >
                {validate.isPending ? "Checking…" : "Validate"}
              </Button>
            </div>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-500">
              Columns for {KIND_LABEL[kind].toLowerCase()} (
              <a href={headerHref} download={`${kind}-template.csv`} className="underline">
                download the header row
              </a>
              )
            </summary>
            <table className="mt-2 w-full text-xs">
              <tbody className="divide-y divide-ink-100">
                {template.columns.map((c) => (
                  <tr key={c.key}>
                    <td className="py-1 pr-3 font-mono">
                      {c.key}
                      {c.required ? " *" : ""}
                    </td>
                    <td className="py-1 pr-3">{c.label}</td>
                    <td className="py-1 text-ink-500">{c.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      )}

      {validation && (
        <section className="panel space-y-3 p-5" aria-label="Validation result">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-medium">{validation.filename}</h2>
              <p className="text-sm text-ink-500">
                {okCount} ok, {validation.report.errorCount} with errors
                {validation.unknownColumns.length > 0 && `. Ignored columns: ${validation.unknownColumns.join(", ")}`}
              </p>
            </div>
            <Button disabled={okCount === 0 || commit.isPending} onClick={() => commit.mutate({ batchId: validation.batchId })}>
              {commit.isPending ? "Committing…" : `Commit ${plural(okCount, "row")}`}
            </Button>
          </div>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Line</th>
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {validation.report.rows.map((r) => (
                  <tr key={r.line}>
                    <td className="px-3 py-1.5 font-mono text-xs">{r.line}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{r.label}</td>
                    <td className="px-3 py-1.5">
                      {r.status === "ok" ? (
                        <Badge variant="ok">ok</Badge>
                      ) : (
                        <ul className="text-xs text-danger-500">
                          {r.errors.map((e, i) => (
                            <li key={i}>
                              <span className="font-mono">{e.column}</span>: {e.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel overflow-x-auto" aria-label="Import batches">
        <h2 className="px-4 py-3 font-medium">Batches</h2>
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">File</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 text-right font-medium">Rows</th>
              <th className="px-3 py-2 text-right font-medium">OK</th>
              <th className="px-3 py-2 text-right font-medium">Errors</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {batches.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-5 text-ink-500">
                  No imports yet.
                </td>
              </tr>
            )}
            {batches.map((b) => (
              <tr key={b.id}>
                <td className="px-3 py-2 text-xs text-ink-500">{when(b.createdAt)}</td>
                <td className="px-3 py-2 font-mono text-xs">{b.filename}</td>
                <td className="px-3 py-2">{KIND_LABEL[b.kind]}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{b.rowCount}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{b.okCount}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{b.errorCount}</td>
                <td className="px-3 py-2">
                  <Badge variant={b.status === "committed" ? "ok" : b.status === "deleted" ? "muted" : "neutral"}>{b.status}</Badge>
                </td>
                <td className="px-3 py-2 text-right text-xs">
                  {canRun && b.status === "committed" && (
                    <button
                      type="button"
                      className="text-danger-500 hover:underline disabled:opacity-50"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate({ batchId: b.id })}
                    >
                      Delete rows
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
