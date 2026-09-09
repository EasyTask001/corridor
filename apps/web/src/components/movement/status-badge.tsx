import type { MovementStatus } from "@corridor/domain";

const STYLES: Record<MovementStatus, string> = {
  draft: "bg-surface-sunken text-fg-primary",
  sent: "bg-signal-500/15 text-status-signal",
  accepted: "bg-ok-500/10 text-status-ok",
  rejected: "bg-danger-500/10 text-status-danger",
  released: "bg-ok-500/15 text-status-ok",
  held: "bg-warn-500/15 text-status-warn",
  arrived: "bg-accent text-accent-fg",
  cancelled: "bg-surface-sunken text-fg-secondary/60 line-through",
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
        regime === "ACE"
          ? "border-border-strong text-fg-primary"
          : "border-signal-500 text-status-signal"
      }`}
      title={regime === "ACE" ? "US CBP — southbound" : "Canada CBSA — northbound"}
    >
      {regime}
    </span>
  );
}
