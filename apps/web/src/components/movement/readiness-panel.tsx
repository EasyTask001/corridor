/**
 * "Ready to cross" panel (Task 14) — the UI consumer of Task 12's
 * `crossingReadiness()` rollup, which `movement.get` already computes and
 * returns as `readiness: { ready, checks }`. Purely presentational: no
 * fetching, no domain logic, just rendering the checks the server sent.
 *
 * Reuses `status-badge.tsx`'s color-token conventions (`ok`/`signal`/`danger`
 * backgrounds paired with `status-ok`/`status-signal`/`status-danger` text) —
 * no new colors are introduced here.
 */
import { CheckCircle2, CircleAlert, Clock } from "lucide-react";
import type { CrossingReadiness, ReadinessState } from "@corridor/domain";

type Headline = "ready" | "waiting" | "blocked";

const HEADLINE_STYLES: Record<Headline, string> = {
  ready: "bg-ok-500/15 text-status-ok",
  waiting: "bg-signal-500/15 text-status-signal",
  blocked: "bg-danger-500/10 text-status-danger",
};

const HEADLINE_LABEL: Record<Headline, string> = {
  ready: "Ready",
  waiting: "Waiting",
  blocked: "Blocked",
};

const CHECK_ICON: Record<ReadinessState, typeof CheckCircle2> = {
  ok: CheckCircle2,
  pending: Clock,
  blocked: CircleAlert,
};

const CHECK_TEXT: Record<ReadinessState, string> = {
  ok: "text-status-ok",
  pending: "text-status-signal",
  blocked: "text-status-danger",
};

function headlineOf(readiness: CrossingReadiness): Headline {
  if (readiness.ready) return "ready";
  return readiness.checks.some((c) => c.state === "blocked") ? "blocked" : "waiting";
}

export function ReadinessPanel({ readiness }: { readiness: CrossingReadiness }) {
  const state = headlineOf(readiness);
  return (
    <section aria-label="Ready to cross" className="panel space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg-primary">Ready to cross</h3>
        <span
          className={`inline-block rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${HEADLINE_STYLES[state]}`}
        >
          {HEADLINE_LABEL[state]}
        </span>
      </div>
      <ul className="space-y-2">
        {readiness.checks.map((check) => {
          const Icon = CHECK_ICON[check.state];
          return (
            <li key={check.key} className="flex items-start gap-2 text-sm">
              <Icon
                className={`mt-0.5 size-3.5 shrink-0 ${CHECK_TEXT[check.state]}`}
                aria-hidden
              />
              <div className="min-w-0">
                <span className="text-fg-primary">{check.label}</span>
                {check.detail && <p className="text-xs text-fg-secondary">{check.detail}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
