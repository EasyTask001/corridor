"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { LOW_CONFIDENCE_THRESHOLD, type ExtractedCargoLine } from "@corridor/domain";
import { useTRPC } from "@/lib/trpc/client";
import { StatusChip } from "../documents-panel";

type Doc = inferRouterOutputs<AppRouter>["documents"]["get"];
type Partner = inferRouterOutputs<AppRouter>["movement"]["options"]["partners"][number];

type LineDraft = {
  commodityDescription: string;
  hsCode: string;
  weightKg: string;
  pieceCount: string;
  packagingType: string;
  valueAmount: string;
  valueCurrency: "" | "USD" | "CAD";
  countryOfOrigin: string;
  confidence: number;
};

const toDraft = (l: ExtractedCargoLine): LineDraft => ({
  commodityDescription: l.commodityDescription,
  hsCode: l.hsCode ?? "",
  weightKg: l.weightKg?.toString() ?? "",
  pieceCount: l.pieceCount?.toString() ?? "",
  packagingType: l.packagingType ?? "",
  valueAmount: l.valueAmount?.toString() ?? "",
  valueCurrency: l.valueCurrency ?? "",
  countryOfOrigin: l.countryOfOrigin ?? "",
  confidence: l.confidence,
});

function Conf({ value }: { value: number }) {
  const low = value < LOW_CONFIDENCE_THRESHOLD;
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${low ? "bg-warn-500/15 text-warn-500" : "bg-ok-500/10 text-ok-500"}`}
      title={low ? "Low confidence — verify against the document" : "Confidence"}
    >
      {Math.round(value * 100)}%
    </span>
  );
}

/** Best-effort partner match by name for the shipper/consignee dropdowns. */
function matchPartner(
  name: string | null | undefined,
  partners: Partner[],
  roles: Partner["type"][],
) {
  if (!name) return "";
  const n = name.trim().toLowerCase();
  const pool = partners.filter((p) => roles.includes(p.type) || p.type === "both");
  const exact = pool.find((p) => p.label.toLowerCase() === n);
  if (exact) return exact.id;
  const partial = pool.find(
    (p) => n.includes(p.label.toLowerCase()) || p.label.toLowerCase().includes(n.split(",")[0]!),
  );
  return partial?.id ?? "";
}

export function ReviewWorkspace({
  initial,
  canReview,
  canUpload,
  draftMovements,
  partners,
}: {
  initial: Doc;
  canReview: boolean;
  canUpload: boolean;
  draftMovements: { id: string; label: string; status: string }[];
  partners: Partner[];
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const getOpts = trpc.documents.get.queryOptions({ id: initial.id });
  const { data: doc } = useQuery({
    ...getOpts,
    initialData: initial,
    refetchInterval: (q) => {
      const s = q.state.data?.uploadStatus ?? initial.uploadStatus;
      return s === "uploaded" || s === "processing" ? 2000 : false;
    },
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.documents.pathKey() });

  return (
    <ReviewForm
      key={`${doc.id}:${doc.extractionCompletedAt ? new Date(doc.extractionCompletedAt).getTime() : doc.uploadStatus}`}
      doc={doc}
      canReview={canReview}
      canUpload={canUpload}
      draftMovements={draftMovements}
      partners={partners}
      invalidate={invalidate}
    />
  );
}

function ReviewForm({
  doc,
  canReview,
  canUpload,
  draftMovements,
  partners,
  invalidate,
}: {
  doc: Doc;
  canReview: boolean;
  canUpload: boolean;
  draftMovements: { id: string; label: string; status: string }[];
  partners: Partner[];
  invalidate: () => void;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const extracted = doc.extractedJson;
  const [lines, setLines] = useState<LineDraft[]>(() => (extracted?.cargo ?? []).map(toDraft));
  const [movementId, setMovementId] = useState(doc.movementId ?? draftMovements[0]?.id ?? "");
  const [shipperId, setShipperId] = useState(() =>
    matchPartner(extracted?.shipper.name, partners, ["shipper"]),
  );
  const [consigneeId, setConsigneeId] = useState(() =>
    matchPartner(extracted?.consignee.name, partners, ["consignee"]),
  );
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [error, setError] = useState<string | null>(null);
  const apply = useMutation(
    trpc.documents.applyExtraction.mutationOptions({
      onSuccess: (r) => {
        invalidate();
        router.push(`/movements/${r.movementId}`);
      },
      onError: (e) => setError(e.message),
    }),
  );
  const retry = useMutation(trpc.documents.retry.mutationOptions({ onSuccess: invalidate }));

  const update = (i: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  const submit = () => {
    setError(null);
    if (!movementId) return setError("Choose a movement to apply the lines to.");
    apply.mutate({
      documentId: doc.id,
      movementId,
      shipperId: shipperId || null,
      consigneeId: consigneeId || null,
      mode,
      lines: lines.map((l) => ({
        commodityDescription: l.commodityDescription.trim(),
        hsCode: l.hsCode.trim() || null,
        weightKg: num(l.weightKg),
        pieceCount: num(l.pieceCount),
        packagingType: l.packagingType.trim() || null,
        valueAmount: num(l.valueAmount),
        valueCurrency: l.valueCurrency || null,
        countryOfOrigin: l.countryOfOrigin.trim().toUpperCase() || null,
        extractionConfidence: l.confidence,
      })),
    });
  };

  const inFlight = doc.uploadStatus === "uploaded" || doc.uploadStatus === "processing";

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm text-ink-500">
            <Link href="/documents" className="hover:underline">
              Documents
            </Link>{" "}
            /
          </div>
          <h1 className="mt-1 flex items-center gap-3 text-2xl font-semibold tracking-tight">
            {doc.originalFilename} <StatusChip status={doc.uploadStatus} />
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            {doc.detectedType
              ? `Detected: ${doc.detectedType.replace("_", " ")}`
              : `Declared: ${doc.documentType}`}
            {doc.extractionModel && (
              <>
                {" "}
                · extracted by <span className="font-mono">{doc.extractionModel}</span>
              </>
            )}
            {doc.extractionConfidence != null && (
              <>
                {" "}
                · overall <Conf value={doc.extractionConfidence} />
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {doc.downloadUrl && (
            <a href={doc.downloadUrl} target="_blank" rel="noreferrer" className="btn-secondary">
              Open original
            </a>
          )}
          {canUpload && (doc.uploadStatus === "failed" || doc.uploadStatus === "extracted") && (
            <button
              className="btn-secondary"
              disabled={retry.isPending}
              onClick={() => retry.mutate({ documentId: doc.id })}
            >
              Re-extract
            </button>
          )}
        </div>
      </header>

      {inFlight && (
        <p className="panel flex items-center gap-2 p-4 text-sm text-signal-600">
          <span className="h-2 w-2 animate-pulse rounded-full bg-signal-500" aria-hidden />
          Extracting shipment data — this page updates automatically.
        </p>
      )}
      {doc.uploadStatus === "failed" && (
        <p role="alert" className="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-danger-500">
          {doc.extractionError}
        </p>
      )}

      {extracted && (
        <>
          <section className="grid gap-4 md:grid-cols-3">
            {(["shipper", "consignee"] as const).map((role) => {
              const p = extracted[role];
              const sel = role === "shipper" ? shipperId : consigneeId;
              const set = role === "shipper" ? setShipperId : setConsigneeId;
              const pool = partners.filter((x) => x.type === role || x.type === "both");
              return (
                <div key={role} className="panel p-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-xs font-medium uppercase tracking-wide text-ink-500">
                      {role}
                    </h2>
                    <Conf value={p.confidence} />
                  </div>
                  <div className="mt-1 font-medium">
                    {p.name ?? <span className="text-danger-500">not found</span>}
                  </div>
                  <div className="text-xs text-ink-500">{p.address ?? ""}</div>
                  <label className="label mt-3" htmlFor={`${role}-partner`}>
                    Match to partner
                  </label>
                  <select
                    id={`${role}-partner`}
                    value={sel}
                    onChange={(e) => set(e.target.value)}
                    disabled={!canReview}
                    className="input"
                  >
                    <option value="">— unmatched —</option>
                    {pool.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
            <div className="panel p-4 text-sm">
              <h2 className="text-xs font-medium uppercase tracking-wide text-ink-500">Document</h2>
              <dl className="mt-1 grid grid-cols-[6rem_1fr] gap-y-1">
                <dt className="text-ink-500">Number</dt>
                <dd className="font-mono">{extracted.documentNumber ?? "—"}</dd>
                <dt className="text-ink-500">Date</dt>
                <dd className="font-mono">{extracted.documentDate ?? "—"}</dd>
                <dt className="text-ink-500">Broker</dt>
                <dd>{extracted.broker?.name ?? "—"}</dd>
                <dt className="text-ink-500">Totals</dt>
                <dd className="font-mono text-xs">
                  {extracted.totals
                    ? `${extracted.totals.weightKg ?? "?"} kg · ${extracted.totals.pieceCount ?? "?"} pcs · ${extracted.totals.valueAmount ?? "?"} ${extracted.totals.valueCurrency ?? ""}`
                    : "—"}
                </dd>
              </dl>
              {extracted.notes.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-warn-500" aria-label="Extractor notes">
                  {extracted.notes.map((n, i) => (
                    <li key={i}>⚠ {n}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {extracted.rateConfirmation && (
            <section className="panel p-4" aria-labelledby="rate-con-heading">
              <div className="flex items-center justify-between">
                <h2
                  id="rate-con-heading"
                  className="text-xs font-medium uppercase tracking-wide text-ink-500"
                >
                  Rate confirmation
                </h2>
                <Conf value={extracted.rateConfirmation.confidence} />
              </div>
              <p className="mt-1 text-xs text-ink-500">
                Load tender — read-only. Rate confirmations carry no commodity detail, so nothing
                here is applied to a movement.
              </p>
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
                {(
                  [
                    ["Carrier", extracted.rateConfirmation.carrierName],
                    ["Broker", extracted.rateConfirmation.brokerName],
                    ["Reference", extracted.rateConfirmation.referenceNumber],
                    [
                      "Rate",
                      extracted.rateConfirmation.rateAmount != null
                        ? `${extracted.rateConfirmation.rateAmount} ${extracted.rateConfirmation.rateCurrency ?? ""}`.trim()
                        : null,
                    ],
                    ["Pickup", extracted.rateConfirmation.pickupAt],
                    ["Delivery", extracted.rateConfirmation.deliveryAt],
                    ["Equipment", extracted.rateConfirmation.equipment],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-ink-500">{label}</dt>
                    <dd className="font-mono text-xs">{value || "—"}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <section className="panel overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Commodity</th>
                  <th className="px-3 py-2 font-medium">HS</th>
                  <th className="px-3 py-2 font-medium">kg</th>
                  <th className="px-3 py-2 font-medium">Pcs</th>
                  <th className="px-3 py-2 font-medium">Pkg</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                  <th className="px-3 py-2 font-medium">Ccy</th>
                  <th className="px-3 py-2 font-medium">Origin</th>
                  <th className="px-3 py-2 font-medium">Conf.</th>
                  {canReview && <th />}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {lines.map((l, i) => {
                  const low = l.confidence < LOW_CONFIDENCE_THRESHOLD;
                  const cls = `input px-2 py-1 text-xs ${low ? "border-warn-500/60" : ""}`;
                  return (
                    <tr key={i} className={low ? "bg-warn-500/5" : ""}>
                      <td className="px-3 py-1.5 font-mono text-xs">{i + 1}</td>
                      <td className="px-3 py-1.5">
                        <input
                          aria-label={`Line ${i + 1} commodity`}
                          value={l.commodityDescription}
                          disabled={!canReview}
                          onChange={(e) => update(i, { commodityDescription: e.target.value })}
                          className={`${cls} min-w-56`}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          aria-label={`Line ${i + 1} HS code`}
                          value={l.hsCode}
                          disabled={!canReview}
                          onChange={(e) => update(i, { hsCode: e.target.value })}
                          className={`${cls} w-24 font-mono`}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          aria-label={`Line ${i + 1} weight`}
                          value={l.weightKg}
                          disabled={!canReview}
                          onChange={(e) => update(i, { weightKg: e.target.value })}
                          className={`${cls} w-20`}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          aria-label={`Line ${i + 1} pieces`}
                          value={l.pieceCount}
                          disabled={!canReview}
                          onChange={(e) => update(i, { pieceCount: e.target.value })}
                          className={`${cls} w-16`}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          aria-label={`Line ${i + 1} packaging`}
                          value={l.packagingType}
                          disabled={!canReview}
                          onChange={(e) => update(i, { packagingType: e.target.value })}
                          className={`${cls} w-20`}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          aria-label={`Line ${i + 1} value`}
                          value={l.valueAmount}
                          disabled={!canReview}
                          onChange={(e) => update(i, { valueAmount: e.target.value })}
                          className={`${cls} w-20`}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <select
                          aria-label={`Line ${i + 1} currency`}
                          value={l.valueCurrency}
                          disabled={!canReview}
                          onChange={(e) =>
                            update(i, {
                              valueCurrency: e.target.value as LineDraft["valueCurrency"],
                            })
                          }
                          className={`${cls} w-18`}
                        >
                          <option value="">—</option>
                          <option value="USD">USD</option>
                          <option value="CAD">CAD</option>
                        </select>
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          aria-label={`Line ${i + 1} origin`}
                          value={l.countryOfOrigin}
                          maxLength={2}
                          disabled={!canReview}
                          onChange={(e) => update(i, { countryOfOrigin: e.target.value })}
                          className={`${cls} w-14 uppercase`}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <Conf value={l.confidence} />
                      </td>
                      {canReview && (
                        <td className="px-3 py-1.5 text-right">
                          <button
                            className="text-xs text-danger-500 hover:underline"
                            onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                          >
                            Remove
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {canReview && (
              <div className="border-t border-ink-100 px-3 py-2">
                <button
                  className="text-xs text-ink-500 hover:text-ink-950"
                  onClick={() =>
                    setLines((ls) => [
                      ...ls,
                      {
                        commodityDescription: "",
                        hsCode: "",
                        weightKg: "",
                        pieceCount: "",
                        packagingType: "",
                        valueAmount: "",
                        valueCurrency: "",
                        countryOfOrigin: "",
                        confidence: 1,
                      },
                    ])
                  }
                >
                  + Add line
                </button>
              </div>
            )}
          </section>

          {canReview && doc.uploadStatus !== "applied" && (
            <section className="panel flex flex-wrap items-end gap-3 p-4">
              <div className="min-w-64">
                <label className="label" htmlFor="applyMovement">
                  Apply to movement
                </label>
                <select
                  id="applyMovement"
                  value={movementId}
                  onChange={(e) => setMovementId(e.target.value)}
                  className="input"
                >
                  <option value="">Select a draft…</option>
                  {draftMovements.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} ({m.status})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="applyMode">
                  Existing lines
                </label>
                <select
                  id="applyMode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as "append" | "replace")}
                  className="input"
                >
                  <option value="append">Keep and append</option>
                  <option value="replace">Replace</option>
                </select>
              </div>
              <button
                className="btn-signal"
                disabled={apply.isPending || lines.length === 0}
                onClick={submit}
              >
                {apply.isPending
                  ? "Applying…"
                  : `Confirm & apply ${lines.length} line${lines.length === 1 ? "" : "s"}`}
              </button>
              {error && (
                <p role="alert" className="w-full text-sm text-danger-500">
                  {error}
                </p>
              )}
              <p className="w-full text-xs text-ink-500">
                You are confirming this data as the reviewer. Low-confidence fields are highlighted;
                check them against the original before applying.
              </p>
            </section>
          )}
          {doc.uploadStatus === "applied" && doc.appliedMovementId && (
            <p className="text-sm text-ok-500">
              Applied to{" "}
              <Link href={`/movements/${doc.appliedMovementId}`} className="underline">
                movement
              </Link>
              .
            </p>
          )}
        </>
      )}
    </div>
  );
}
