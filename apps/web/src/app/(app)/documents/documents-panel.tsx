"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  type DocumentType,
} from "@corridor/domain";
import { useTRPC } from "@/lib/trpc/client";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { useRealtimeClient } from "@/lib/supabase/use-realtime-client";

type List = inferRouterOutputs<AppRouter>["documents"]["list"];

const TYPE_LABEL: Record<DocumentType, string> = {
  bol: "Bill of lading",
  invoice: "Commercial invoice",
  rate_confirmation: "Rate confirmation",
  other: "Other",
};

export function StatusChip({ status }: { status: List["rows"][number]["uploadStatus"] }) {
  const cls: Record<string, string> = {
    uploaded: "bg-surface-sunken text-fg-secondary",
    processing: "bg-signal-500/15 text-status-signal",
    extracted: "bg-warn-500/15 text-status-warn",
    failed: "bg-danger-500/10 text-status-danger",
    applied: "bg-ok-500/10 text-status-ok",
  };
  const label: Record<string, string> = {
    uploaded: "queued",
    processing: "extracting…",
    extracted: "review",
    failed: "failed",
    applied: "applied",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${cls[status]}`}
    >
      {status === "processing" && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-500" aria-hidden />
      )}
      {label[status]}
    </span>
  );
}

export function DocumentsPanel({
  initial,
  canUpload,
  canReview,
  draftMovements,
  preselectedMovementId,
}: {
  initial: List;
  canUpload: boolean;
  canReview: boolean;
  draftMovements: { id: string; label: string }[];
  preselectedMovementId: string | null;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const listOpts = trpc.documents.list.queryOptions({ limit: 100, offset: 0 });
  const { data } = useQuery({
    ...listOpts,
    initialData: initial,
    // Realtime below is the live path. This is reconciliation only — it catches
    // a dropped socket or a throttled background tab while the worker is
    // extracting, and stops entirely once nothing is in flight.
    refetchInterval: (q) =>
      q.state.data?.rows.some(
        (r) => r.uploadStatus === "uploaded" || r.uploadStatus === "processing",
      )
        ? 15_000
        : false,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.documents.pathKey() });

  // Realtime: flip rows as the worker updates them (polling above reconciles).
  const realtime = useRealtimeClient();
  useEffect(() => {
    if (!realtime) return;
    const ch = realtime
      .channel("documents")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "source_documents" },
        () => void invalidate(),
      )
      .subscribe();
    return () => {
      void realtime.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realtime]);

  const getUploadUrl = useMutation(trpc.documents.getUploadUrl.mutationOptions());
  const finalize = useMutation(
    trpc.documents.finalizeUpload.mutationOptions({ onSuccess: invalidate }),
  );
  const retry = useMutation(trpc.documents.retry.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(trpc.documents.remove.mutationOptions({ onSuccess: invalidate }));

  const [docType, setDocType] = useState<DocumentType>("bol");
  const [movementId, setMovementId] = useState<string>(preselectedMovementId ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | File[]) {
    setError(null);
    for (const file of Array.from(files)) {
      if (!(ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(file.type)) {
        setError(`${file.name}: unsupported type ${file.type || "unknown"}`);
        continue;
      }
      if (file.size > MAX_DOCUMENT_BYTES) {
        setError(`${file.name}: larger than 25 MB`);
        continue;
      }
      setBusy(file.name);
      try {
        const target = await getUploadUrl.mutateAsync({
          filename: file.name,
          mimeType: file.type as (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number],
          sizeBytes: file.size,
          documentType: docType,
          movementId: movementId || undefined,
        });
        // Direct-to-Storage upload; the Next.js function never sees the bytes.
        const supabase = createSupabaseBrowserClient();
        const { error: upErr } = await supabase.storage
          .from("documents")
          .uploadToSignedUrl(target.path, target.token, file, { contentType: file.type });
        if (upErr) throw new Error(upErr.message);
        await finalize.mutateAsync({ documentId: target.documentId });
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(null);
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="space-y-4">
      {canUpload && (
        <div
          className="panel flex flex-wrap items-end gap-3 border-dashed p-4"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void upload(e.dataTransfer.files);
          }}
        >
          <div>
            <label className="label" htmlFor="docType">
              Document type
            </label>
            <select
              id="docType"
              value={docType}
              onChange={(e) => setDocType(e.target.value as DocumentType)}
              className="input"
            >
              {(Object.keys(TYPE_LABEL) as DocumentType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="w-full min-w-0 sm:w-auto sm:min-w-64">
            <label className="label" htmlFor="movementId">
              Attach to movement (optional)
            </label>
            <select
              id="movementId"
              value={movementId}
              onChange={(e) => setMovementId(e.target.value)}
              className="input"
            >
              <option value="">— none —</option>
              {draftMovements.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="file">
              File
            </label>
            <input
              id="file"
              ref={fileRef}
              type="file"
              multiple
              accept={ALLOWED_DOCUMENT_MIME_TYPES.join(",")}
              onChange={(e) => e.target.files && void upload(e.target.files)}
              className="text-sm"
            />
          </div>
          <p className="w-full text-xs text-fg-secondary">
            PDF, images or text up to 25 MB. Drop files anywhere on this box.
            {busy && <span className="ml-2 text-status-signal">Uploading {busy}…</span>}
          </p>
          {error && (
            <p role="alert" className="w-full text-sm text-status-danger">
              {error}
            </p>
          )}
        </div>
      )}

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-fg-secondary">
            <tr>
              <th className="px-4 py-2 font-medium">Document</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Confidence</th>
              <th className="px-4 py-2 font-medium">Lines</th>
              <th className="px-4 py-2 font-medium">Movement</th>
              <th className="px-4 py-2 font-medium">Uploaded</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-fg-secondary">
                  No documents yet.
                </td>
              </tr>
            )}
            {data.rows.map((d) => (
              <tr key={d.id} className="hover:bg-surface-sunken">
                <td className="px-4 py-2">
                  <Link href={`/documents/${d.id}`} className="font-medium hover:underline">
                    {d.originalFilename}
                  </Link>
                  {d.extractionError && (
                    <div
                      className="max-w-md truncate text-xs text-status-danger"
                      title={d.extractionError}
                    >
                      {d.extractionError}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 text-xs">
                  {TYPE_LABEL[d.detectedType ?? d.documentType]}
                  {d.detectedType && d.detectedType !== d.documentType && (
                    <span className="ml-1 text-fg-secondary">(detected)</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <StatusChip status={d.uploadStatus} />
                </td>
                <td className="px-4 py-2 font-mono text-xs">
                  {d.extractionConfidence != null ? (
                    <span
                      className={
                        d.extractionConfidence < 0.7 ? "text-status-warn" : "text-status-ok"
                      }
                    >
                      {Math.round(d.extractionConfidence * 100)}%
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2 font-mono text-xs">{d.lineCount || "—"}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  {d.movementId ? (
                    <Link href={`/movements/${d.movementId}`} className="hover:underline">
                      {d.movementNumber}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-xs text-fg-secondary">
                  {new Date(d.createdAt).toLocaleString("en-CA", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                  {d.uploadedByName && <div>{d.uploadedByName}</div>}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right text-xs">
                  {canReview && d.uploadStatus === "extracted" && (
                    <Link href={`/documents/${d.id}`} className="btn-signal px-2.5 py-1 text-xs">
                      Review
                    </Link>
                  )}
                  {canUpload && d.uploadStatus === "failed" && (
                    <button
                      className="ml-2 text-fg-secondary hover:text-fg-primary"
                      onClick={() => retry.mutate({ documentId: d.id })}
                    >
                      Retry
                    </button>
                  )}
                  {canUpload && d.uploadStatus !== "applied" && (
                    <button
                      className="ml-3 text-status-danger hover:underline"
                      onClick={() => remove.mutate({ id: d.id })}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
