"use client";

import { useMutation } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import { useTRPC } from "@/lib/trpc/client";

type Status = inferRouterOutputs<AppRouter>["billing"]["status"];
type Plans = inferRouterOutputs<AppRouter>["billing"]["plans"]["plans"];

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
