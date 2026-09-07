/**
 * Stripe wrapper. Card data never touches Corridor: Checkout + Billing Portal
 * are hosted by Stripe; we only mirror subscription state via webhooks.
 *
 * When STRIPE_SECRET_KEY is absent (local dev / CI) the wrapper runs in
 * "mock" mode: checkout returns an internal URL that activates the plan
 * immediately, so the billing UI and DB sync are still exercised end-to-end.
 */
import Stripe from "stripe";
import type { SubscriptionPlan } from "@corridor/domain";

export type BillingMode = "stripe" | "mock";

export interface BillingPlan {
  plan: Exclude<SubscriptionPlan, "trial">;
  name: string;
  monthlyUsd: number;
  seats: number;
  features: string[];
}

export const BILLING_PLANS: BillingPlan[] = [
  {
    plan: "starter",
    name: "Starter",
    monthlyUsd: 149,
    seats: 3,
    features: ["ACE + ACI e-manifests", "Registries & expiry alerts", "3 users"],
  },
  {
    plan: "professional",
    name: "Professional",
    monthlyUsd: 399,
    seats: 10,
    features: [
      "Everything in Starter",
      "AI document intelligence",
      "Compliance copilot",
      "10 users",
    ],
  },
  {
    plan: "enterprise",
    name: "Enterprise",
    monthlyUsd: 999,
    seats: 50,
    features: [
      "Everything in Professional",
      "Custom roles & SSO",
      "Usage-based billing",
      "Priority support",
    ],
  },
];

export interface StripeEnv {
  secretKey?: string;
  webhookSecret?: string;
  /** Stripe Price IDs per plan, e.g. STRIPE_PRICE_STARTER */
  prices?: Partial<Record<BillingPlan["plan"], string>>;
}

export function readStripeEnv(env: NodeJS.ProcessEnv = process.env): StripeEnv {
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    prices: {
      starter: env.STRIPE_PRICE_STARTER,
      professional: env.STRIPE_PRICE_PROFESSIONAL,
      enterprise: env.STRIPE_PRICE_ENTERPRISE,
    },
  };
}

export function billingMode(env: StripeEnv = readStripeEnv()): BillingMode {
  return env.secretKey ? "stripe" : "mock";
}

export function stripeClient(env: StripeEnv = readStripeEnv()): Stripe | null {
  return env.secretKey ? new Stripe(env.secretKey) : null;
}

export interface CheckoutInput {
  organizationId: string;
  plan: BillingPlan["plan"];
  customerId: string | null;
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
}

export async function createCheckout(input: CheckoutInput, env: StripeEnv = readStripeEnv()) {
  const stripe = stripeClient(env);
  if (!stripe) {
    // mock: the app's own route activates the plan and redirects back
    const u = new URL(input.successUrl);
    u.searchParams.set("mock_checkout", input.plan);
    return { mode: "mock" as const, url: u.toString() };
  }
  const price = env.prices?.[input.plan];
  if (!price) throw new Error(`Missing Stripe price id for plan ${input.plan}`);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    ...(input.customerId
      ? { customer: input.customerId }
      : { customer_email: input.customerEmail ?? undefined }),
    client_reference_id: input.organizationId,
    metadata: { organizationId: input.organizationId, plan: input.plan },
    subscription_data: { metadata: { organizationId: input.organizationId, plan: input.plan } },
  });
  return { mode: "stripe" as const, url: session.url! };
}

export async function createPortal(
  customerId: string,
  returnUrl: string,
  env: StripeEnv = readStripeEnv(),
) {
  const stripe = stripeClient(env);
  if (!stripe) return { mode: "mock" as const, url: returnUrl };
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { mode: "stripe" as const, url: session.url };
}

/** Verify + parse a webhook. Returns null when signature is invalid. */
export function parseWebhook(
  rawBody: string,
  signature: string | null,
  env: StripeEnv = readStripeEnv(),
): Stripe.Event | null {
  const stripe = stripeClient(env);
  if (!stripe || !env.webhookSecret || !signature) return null;
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, env.webhookSecret);
  } catch {
    return null;
  }
}

/** Normalised subscription facts the app cares about. */
export interface SubscriptionSnapshot {
  organizationId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  plan: SubscriptionPlan;
  status: "trialing" | "active" | "past_due" | "canceled" | "incomplete";
  seats: number;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export function snapshotFromStripeSubscription(
  sub: Stripe.Subscription,
): SubscriptionSnapshot | null {
  const organizationId = sub.metadata?.organizationId;
  const plan = sub.metadata?.plan as SubscriptionPlan | undefined;
  if (!organizationId || !plan) return null;
  const statusMap: Record<Stripe.Subscription.Status, SubscriptionSnapshot["status"]> = {
    trialing: "trialing",
    active: "active",
    past_due: "past_due",
    canceled: "canceled",
    unpaid: "past_due",
    incomplete: "incomplete",
    incomplete_expired: "canceled",
    paused: "past_due",
  };
  const item = sub.items.data[0];
  return {
    organizationId,
    stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    stripeSubscriptionId: sub.id,
    plan,
    status: statusMap[sub.status] ?? "incomplete",
    seats: item?.quantity ?? 1,
    currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  };
}
