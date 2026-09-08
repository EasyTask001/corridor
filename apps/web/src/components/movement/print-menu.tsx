"use client";

/**
 * Print / download the driver sheet or the manifest summary for a movement.
 * Each action renders a fresh PDF (the sheet must show the manifest as it is
 * now), then either opens it in a new tab or hands the browser the file.
 * "Send by e-mail" mails a 24-hour link to the last rendered document.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";

type Kind = "driver_sheet" | "manifest_summary";
const LABEL: Record<Kind, string> = { driver_sheet: "Driver sheet", manifest_summary: "Manifest summary" };

export function PrintMenu({ movementId }: { movementId: string }) {
  const trpc = useTRPC();
  const [last, setLast] = useState<{ kind: Kind; url: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mailTo, setMailTo] = useState("");
  const [mailed, setMailed] = useState<string | null>(null);
  const email = useMutation(
    trpc.pdf.email.mutationOptions({
      onSuccess: (r) => {
        setError(null);
        const ok = r.results.filter((x) => x.ok).length;
        setMailed(`Sent to ${ok} of ${r.results.length} address${r.results.length === 1 ? "" : "es"}${r.results[0]?.mode === "mock" ? " (mock mail)" : ""}.`);
      },
      onError: (e) => setError(e.message),
    }),
  );
  const generate = useMutation(
    trpc.pdf.generate.mutationOptions({
      onSuccess: (doc, vars) => {
        setError(null);
        setLast({ kind: vars.kind, url: doc.signedUrl, id: doc.id });
      },
      onError: (e) => setError(e.message),
    }),
  );

  const run = (kind: Kind, mode: "print" | "download") => {
    // Open the tab first (from the click, so popup blockers allow it), then
    // point it at the signed URL once the PDF exists.
    const tab = mode === "print" ? window.open("", "_blank") : null;
    generate.mutate(
      { movementId, kind },
      {
        onSuccess: (doc) => {
          if (tab) tab.location.href = doc.signedUrl;
          else window.location.assign(doc.signedUrl);
        },
        onError: () => tab?.close(),
      },
    );
  };

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Paperwork</h3>
        <div className="flex flex-wrap gap-2">
          {(["driver_sheet", "manifest_summary"] as const).map((kind) => (
            <span key={kind} className="inline-flex overflow-hidden rounded-md border border-ink-100">
              <button
                type="button"
                className="px-3 py-1.5 text-sm hover:bg-ink-50 disabled:opacity-50"
                disabled={generate.isPending}
                onClick={() => run(kind, "print")}
              >
                Print {LABEL[kind].toLowerCase()}
              </button>
              <button
                type="button"
                className="border-l border-ink-100 px-3 py-1.5 text-sm hover:bg-ink-50 disabled:opacity-50"
                disabled={generate.isPending}
                onClick={() => run(kind, "download")}
                aria-label={`Download ${LABEL[kind]} PDF`}
              >
                Download PDF
              </button>
            </span>
          ))}
        </div>
      </div>
      {generate.isPending && <p className="mt-2 text-xs text-ink-500">Rendering…</p>}
      {error && <p className="mt-2 text-xs text-danger-500">{error}</p>}
      {last && !generate.isPending && (
        <>
          <p className="mt-2 text-xs text-ink-500">
            {LABEL[last.kind]} ready:{" "}
            <a href={last.url} className="underline" target="_blank" rel="noopener" data-testid="pdf-link">
              open PDF
            </a>
            <span className="ml-1 text-ink-300">(link valid for one minute)</span>
          </p>
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const to = mailTo
                .split(/[,;\s]+/)
                .map((s) => s.trim())
                .filter(Boolean);
              if (to.length) email.mutate({ id: last.id, to });
            }}
          >
            <div className="min-w-64 flex-1">
              <label htmlFor="pdfMailTo" className="label">
                Send {LABEL[last.kind].toLowerCase()} by e-mail
              </label>
              <input
                id="pdfMailTo"
                value={mailTo}
                onChange={(e) => setMailTo(e.target.value)}
                placeholder="broker@example.com, dispatch@example.com"
                className="input"
              />
            </div>
            <button className="btn-secondary" disabled={email.isPending || !mailTo.trim()}>
              {email.isPending ? "Sending…" : "Send"}
            </button>
            {mailed && <span className="text-xs text-ok-500">{mailed}</span>}
          </form>
        </>
      )}
    </div>
  );
}
