"use client";

import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@corridor/ui";
import { useTRPC } from "@/lib/trpc/client";

const EXAMPLES = [
  "How many movements by status in the last 30 days?",
  "Show total cargo weight by crossing this year",
  "What was the rejection rate by regime in the last 90 days?",
  "Show declared value in USD by month this year",
];

export function ReportWorkbench() {
  const trpc = useTRPC();
  const [question, setQuestion] = useState(EXAMPLES[0]!);
  const run = useMutation(trpc.reporting.run.mutationOptions());
  const result = run.data;
  const [exported, setExported] = useState<{ url: string; format: string } | null>(null);
  const exportResult = useMutation(
    trpc.reporting.export.mutationOptions({
      onSuccess: (r) => setExported({ url: r.signedUrl, format: r.format }),
    }),
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run.mutate({ question });
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-fg-secondary">
        Ask about movement volume, cargo, rejection, or hold history. Questions are translated into
        a constrained reporting query, never raw SQL.
      </p>

      <form className="panel space-y-3 p-5" onSubmit={submit} aria-label="Run a report">
        <label className="label" htmlFor="reportQuestion">
          What do you want to know?
        </label>
        <div className="flex gap-3">
          <input
            id="reportQuestion"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={500}
            className="input flex-1"
            placeholder="How many movements were rejected by month this year?"
          />
          <button className="btn-primary" disabled={run.isPending || !question.trim()}>
            {run.isPending ? "Running…" : "Run report"}
          </button>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Example questions">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="rounded-full border border-border-default bg-surface-raised px-3 py-1 text-left text-xs text-fg-secondary hover:bg-surface-sunken hover:text-fg-primary"
              onClick={() => setQuestion(example)}
            >
              {example}
            </button>
          ))}
        </div>
      </form>

      {run.error && (
        <p
          role="alert"
          className="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-status-danger"
        >
          {run.error.message}
        </p>
      )}

      {result && (
        <div className="space-y-4" aria-live="polite">
          <section className="panel p-5">
            <div className="text-xs font-medium uppercase tracking-wide text-fg-secondary">
              Interpreted query
            </div>
            <h2 className="mt-1 text-xl font-semibold">{result.title}</h2>
            <p className="mt-1 text-sm text-fg-secondary">{result.interpretation}</p>
            <p className="mt-4 text-lg font-medium">{result.summary}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {Object.entries(result.query).map(([key, value]) => (
                <span
                  key={key}
                  className="rounded bg-surface-sunken px-2 py-1 font-mono text-fg-primary"
                >
                  {key}: {String(value)}
                </span>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
              {(["csv", "pdf"] as const).map((format) => (
                <Button
                  key={format}
                  variant="secondary"
                  size="sm"
                  disabled={exportResult.isPending || result.rows.length === 0}
                  onClick={() =>
                    exportResult.mutate({
                      format,
                      source: { kind: "query", query: result.query, title: result.title },
                    })
                  }
                >
                  Export {format.toUpperCase()}
                </Button>
              ))}
              {exported && (
                <a
                  href={exported.url}
                  target="_blank"
                  rel="noopener"
                  data-testid="report-export-link"
                  className="font-medium underline underline-offset-2"
                >
                  Download {exported.format.toUpperCase()}
                </a>
              )}
              {exportResult.error && (
                <span role="alert" className="text-status-danger">
                  {exportResult.error.message}
                </span>
              )}
            </div>
          </section>

          {result.rows.length > 0 && (
            <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
              <ReportChart title={result.title} rows={result.rows} unit={result.unit} />
              <div className="panel overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-fg-secondary">
                    <tr>
                      <th className="px-4 py-2 font-medium">Group</th>
                      <th className="px-4 py-2 text-right font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-default">
                    {result.rows.map((row) => (
                      <tr key={row.label}>
                        <td className="px-4 py-2">{row.label}</td>
                        <td className="px-4 py-2 text-right font-mono">
                          {formatValue(row.value, result.unit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ReportChart({
  title,
  rows,
  unit,
}: {
  title: string;
  rows: Array<{ label: string; value: number }>;
  unit: string;
}) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <figure className="panel p-5" aria-label={`${title} bar chart`}>
      <figcaption className="font-medium">{title}</figcaption>
      <ul className="mt-4 space-y-3">
        {rows.map((row) => (
          <li key={row.label}>
            <div className="mb-1 flex justify-between gap-4 text-xs">
              <span className="truncate">{row.label}</span>
              <span className="shrink-0 font-mono">{formatValue(row.value, unit)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
              <div
                className="h-full rounded-full bg-signal-500"
                style={{ width: `${Math.max(1, (row.value / max) * 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function formatValue(value: number, unit: string) {
  if (unit === "USD" || unit === "CAD") {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: unit,
      maximumFractionDigits: 0,
    }).format(value);
  }
  const number = value.toLocaleString("en-CA", {
    maximumFractionDigits: unit === "%" ? 1 : 2,
  });
  return unit === "%" ? `${number}%` : `${number} ${unit}`;
}
