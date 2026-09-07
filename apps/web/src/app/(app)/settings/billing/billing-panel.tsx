"use client";

import { useMutation } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { useTRPC } from "@/lib/trpc/client";

type Status = inferRouterOutputs<AppRouter>["billing"]["status"];
type Plans = inferRouterOutputs<AppRouter>["billing"]["plans"]["plans"];
type Usage = Status["usage"];

const usd = (n: number) => `$${n.toFixed(2)}`;
const count = (n: number) => n.toLocaleString("en-CA");

/**
 * This period's meter against the plan's allowance. Visible to every caller who
 * can read billing: `usage_records` is gated on the same `billing.read`.
 */
function UsageTable({ usage }: { usage: Usage }) {
  const rows = [
    { label: "Documents extracted", ...usage.documents, unit: "per document" },
    { label: "Copilot messages", ...usage.copilotMessages, unit: "per message" },
  ];
  const periodLabel = new Date(`${usage.periodStart}T00:00:00Z`).toLocaleDateString("en-CA", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">Usage this period</h2>
        <span className="text-sm text-ink-500">{periodLabel}</span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-ink-500">
            <tr className="border-b border-ink-100">
              <th className="py-2 pr-4 font-medium">Metric</th>
              <th className="py-2 pr-4 text-right font-medium">Used</th>
              <th className="py-2 pr-4 text-right font-medium">Included</th>
              <th className="py-2 pr-4 text-right font-medium">Over</th>
              <th className="py-2 text-right font-medium">Projected</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((row) => (
              <tr key={row.label}>
                <td className="py-2 pr-4">
                  {row.label}
                  {row.included !== null && row.unitUsd > 0 && (
                    <span className="text-ink-500">
                      {" "}
                      · {usd(row.unitUsd)} {row.unit}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{count(row.used)}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-ink-500">
                  {row.included === null ? "Unlimited" : count(row.included)}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {row.billable > 0 ? count(row.billable) : "—"}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {row.amountUsd > 0 ? usd(row.amountUsd) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="text-ink-500">
          {count(usage.totals.movements_transmitted)} manifests transmitted ·{" "}
          {count(usage.totals.ai_suggestions)} AI suggestions (not charged)
        </span>
        <span className="font-medium">
          Projected overage {usd(usage.projectedOverageUsd)}
          {usage.projectedOverageUsd === 0 && (
            <span className="font-normal text-ink-500"> — within plan</span>
          )}
        </span>
      </div>
    </section>
  );
}

export function BillingPanel({
  status,
  plans,
  mode,
  canManage,
  notice,
}: {
  status: Status;
  plans: Plans;
  mode: "stripe" | "mock";
  canManage: boolean;
  notice: string | null;
}) {
  const trpc = useTRPC();
  const checkout = useMutation(
    trpc.billing.checkout.mutationOptions({
      onSuccess: (r) => {
        window.location.assign(r.url);
      },
    }),
  );
  const portal = useMutation(
    trpc.billing.portal.mutationOptions({
      onSuccess: (r) => {
        window.location.assign(r.url);
      },
    }),
  );

  return (
    <div className="space-y-6">
      {notice && <p className="rounded-md bg-ok-500/10 px-3 py-2 text-sm text-ok-500">{notice}</p>}

      <section className="panel flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Current plan
          </div>
          <div className="mt-1 text-2xl font-semibold capitalize">
            {status.plan}{" "}
            <span className="text-base font-normal text-ink-500">
              · {status.status.replace("_", " ")}
            </span>
          </div>
          {status.subscription?.currentPeriodEnd && (
            <div className="text-sm text-ink-500">
              {status.subscription.cancelAtPeriodEnd ? "Ends" : "Renews"}{" "}
              {new Date(status.subscription.currentPeriodEnd).toLocaleDateString("en-CA", {
                dateStyle: "medium",
              })}{" "}
              · {status.subscription.seats} seats
            </div>
          )}
        </div>
        {canManage && status.plan !== "trial" && (
          <button
            className="btn-secondary"
            disabled={portal.isPending}
            onClick={() => portal.mutate()}
          >
            {mode === "stripe" ? "Manage in Stripe portal" : "Manage subscription"}
          </button>
        )}
      </section>

      <UsageTable usage={status.usage} />

      <section className="grid gap-4 md:grid-cols-3">
        {plans.map((p) => {
          const current = status.plan === p.plan;
          return (
            <div
              key={p.plan}
              className={`panel flex flex-col p-5 ${current ? "border-ink-950" : ""}`}
            >
              <div className="flex items-baseline justify-between">
                <h2 className="font-medium">{p.name}</h2>
                <span className="text-lg font-semibold">
                  ${p.monthlyUsd}
                  <span className="text-xs font-normal text-ink-500">/mo</span>
                </span>
              </div>
              <ul className="mt-3 flex-1 space-y-1 text-sm text-ink-700">
                {p.features.map((f) => (
                  <li key={f}>· {f}</li>
                ))}
              </ul>
              {canManage && (
                <button
                  className={`mt-4 ${current ? "btn-secondary" : "btn-primary"}`}
                  disabled={current || checkout.isPending}
                  onClick={() => checkout.mutate({ plan: p.plan })}
                >
                  {current ? "Current plan" : `Choose ${p.name}`}
                </button>
              )}
            </div>
          );
        })}
      </section>
      {(checkout.error || portal.error) && (
        <p className="text-sm text-danger-500">
          {checkout.error?.message ?? portal.error?.message}
        </p>
      )}
    </div>
  );
}
