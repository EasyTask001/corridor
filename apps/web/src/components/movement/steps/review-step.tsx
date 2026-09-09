"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { PrintMenu } from "../print-menu";
import { RecordHistoryDialog } from "@/components/record-history";
import { fmt, stepForIssue, useWorkspace, type Movement } from "../workspace-context";

export function ReviewStep() {
  const trpc = useTRPC();
  const { movement: m, validation, goToStep } = useWorkspace();
  const integrationLog = useQuery({
    ...trpc.integrations.events.forMovement.queryOptions({ movementId: m.id }),
    refetchInterval:
      m.status === "sent" || m.status === "accepted" || m.status === "held" ? 4000 : false,
  });

  const blocking = validation.issues.filter((i) => i.severity === "blocking");
  const warnings = validation.issues.filter((i) => i.severity === "warning");

  return (
    <div className="max-w-2xl space-y-5">
      <div className="panel p-5">
        <h3 className="font-medium">Pre-transmit checks</h3>
        {validation.issues.length === 0 ? (
          <p className="mt-2 text-sm text-status-ok">
            All checks pass. Ready to transmit to {m.regime === "ACE" ? "CBP" : "CBSA"}.
          </p>
        ) : (
          <ul className="mt-3 space-y-1.5 text-sm">
            {blocking.map((i) => (
              <li key={i.code} className="flex gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-danger-500/10 px-1.5 text-xs font-semibold uppercase text-status-danger">
                  block
                </span>
                <button
                  className="text-left hover:underline"
                  onClick={() => goToStep(stepForIssue(i.step))}
                >
                  {i.message}
                </button>
              </li>
            ))}
            {warnings.map((i) => (
              <li key={i.code} className="flex gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-warn-500/10 px-1.5 text-xs font-semibold uppercase text-status-warn">
                  warn
                </span>
                <button
                  className="text-left hover:underline"
                  onClick={() => goToStep(stepForIssue(i.step))}
                >
                  {i.message}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Summary m={m} />
      <div className="flex flex-wrap items-center gap-4">
        <PrintMenu movementId={m.id} />
        <RecordHistoryDialog
          entityType="movement"
          entityId={m.id}
          label={m.movementNumber}
          size="sm"
        />
      </div>
      {integrationLog.data && integrationLog.data.length > 0 && (
        <div className="panel p-5">
          <h3 className="font-medium">Customs transmission log</h3>
          <ul className="mt-2 space-y-1.5 text-sm" aria-label="Transmission log">
            {integrationLog.data.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-xs text-fg-secondary">
                  {new Date(e.createdAt).toLocaleTimeString("en-CA")}
                </span>
                <span className="font-mono text-xs">{e.provider}</span>
                <span>
                  {e.direction === "outbound" ? "→" : "←"} {e.operation}
                </span>
                {e.success ? (
                  <span className="text-xs text-status-ok">
                    ok
                    {typeof e.responsePayload?.decision === "string"
                      ? ` · ${e.responsePayload.decision}`
                      : ""}
                  </span>
                ) : (
                  <span className="text-xs text-status-danger">
                    {e.statusCode} · {e.errorMessage}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {m.amendments.length > 0 && (
        <div className="panel p-5">
          <h3 className="font-medium">Amendments</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {m.amendments.map((a) => (
              <li key={a.id}>
                <span className="font-mono">#{a.amendmentNumber}</span> ·{" "}
                <span className="capitalize">{a.status}</span> — {a.reason}
                <ul className="ml-4 text-xs text-fg-secondary">
                  {Object.entries(a.diff).map(([k, v]) => (
                    <li key={k}>
                      {k}: {JSON.stringify(v.before)} → {JSON.stringify(v.after)}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Summary({ m }: { m: Movement }) {
  const lines = m.shipments.flatMap((s) => s.commodities);
  const totalKg = lines.reduce((sum, c) => sum + (c.weightKg ?? 0), 0);
  const pieces = lines.reduce((sum, c) => sum + (c.quantity ?? 0), 0);
  return (
    <div className="panel grid grid-cols-1 gap-x-6 gap-y-2 p-5 text-sm sm:grid-cols-3">
      {[
        ["Crew", m.crew.map((c) => `${c.firstName} ${c.lastName}`).join(", ") || "—"],
        ["Truck", m.truck?.unitNumber ?? "—"],
        ["Trailers", m.trailers.map((t) => t.unitNumber).join(" + ") || "—"],
        ["Shipments", m.isEmpty ? "Empty trip" : String(m.shipments.length)],
        ["Lines", String(lines.length)],
        ["Total weight", `${totalKg.toLocaleString()} kg`],
        ["Pieces", String(pieces)],
        [
          "Seals",
          [
            ...m.seals.filter((s) => !s.movementTrailerId).map((s) => `${s.sealNumber} (truck)`),
            ...m.trailers.flatMap((t) => t.seals.map((s) => `${s.sealNumber} (${t.unitNumber})`)),
          ].join(", ") || "—",
        ],
        ["Submitted", fmt(m.submittedAt)],
        ["Released", fmt(m.releasedAt)],
      ].map(([k, v]) => (
        <div key={k}>
          <div className="text-xs uppercase tracking-wide text-fg-secondary">{k}</div>
          <div className="font-medium">{v}</div>
        </div>
      ))}
    </div>
  );
}
