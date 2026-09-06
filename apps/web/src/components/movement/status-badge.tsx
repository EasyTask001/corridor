import type { MovementStatus } from "@corridor/domain";

const STYLES: Record<MovementStatus, string> = {
  draft: "bg-ink-100 text-ink-700",
  sent: "bg-signal-500/15 text-signal-600",
  accepted: "bg-ok-500/10 text-ok-500",
  rejected: "bg-danger-500/10 text-danger-500",
  released: "bg-ok-500/15 text-ok-500",
  held: "bg-warn-500/15 text-warn-500",
  arrived: "bg-ink-950 text-white",
  cancelled: "bg-ink-100 text-ink-300 line-through",
};

export function StatusBadge({ status }: { status: MovementStatus }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${STYLES[status]}`}
    >
      {status}
    </span>
  );
}

export function RegimeBadge({ regime }: { regime: "ACE" | "ACI" }) {
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 font-mono text-xs font-semibold ${
        regime === "ACE" ? "border-ink-700 text-ink-700" : "border-signal-600 text-signal-600"
      }`}
      title={regime === "ACE" ? "US CBP — southbound" : "Canada CBSA — northbound"}
    >
      {regime}
    </span>
  );
}
