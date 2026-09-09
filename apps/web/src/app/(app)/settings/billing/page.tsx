import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { api } from "@/lib/trpc/server";
import { BillingPanel } from "./billing-panel";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; mock_checkout?: string }>;
}) {
  const session = await getSession();
  if (!session?.permissions.has("billing.read")) redirect("/dashboard");
  const sp = await searchParams;
  const caller = await api();

  // Mock-mode checkout completion (no Stripe configured): activate then clean the URL.
  if (sp.mock_checkout && session.permissions.has("billing.manage")) {
    const plan = sp.mock_checkout;
    if (plan === "starter" || plan === "professional" || plan === "enterprise") {
      await caller.billing.mockActivate({ plan });
    }
    redirect("/settings/billing?checkout=success");
  }

  const [status, plans] = await Promise.all([caller.billing.status(), caller.billing.plans()]);
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-fg-secondary">
          Payments are handled by Stripe Checkout and the Billing Portal — card details never touch
          Corridor.
          {plans.mode === "mock" &&
            " Stripe is not configured in this environment; checkout runs in mock mode."}
        </p>
      </header>
      <BillingPanel
        status={status}
        plans={plans.plans}
        mode={plans.mode}
        canManage={session.permissions.has("billing.manage")}
        notice={
          sp.checkout === "success"
            ? "Subscription updated."
            : sp.checkout === "cancelled"
              ? "Checkout cancelled."
              : null
        }
      />
    </div>
  );
}
