/**
 * Stripe wrapper. Card data never touches Corridor: Checkout + Billing Portal
 * are hosted by Stripe; we only mirror subscription state via webhooks.
 *
 * When STRIPE_SECRET_KEY is absent (local dev / CI) the wrapper runs in
 * "mock" mode: checkout returns an internal URL that activates the plan
 * immediately, so the billing UI and DB sync are still exercised end-to-end.
 */
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import type { SubscriptionPlan } from "@corridor/domain";

export type BillingMode = "stripe" | "mock";

/**
 * Metered allowance for a plan. `null` included = unlimited (enterprise), in
 * which case there is never an overage. Prices are USD per unit beyond the
 * included allowance.
 */
export interface PlanUsage {
  includedDocuments: number | null;
  includedCopilotMessages: number | null;
  overageUsdPerDocument: number;
  overageUsdPerMessage: number;
}

export interface BillingPlan {
  plan: Exclude<SubscriptionPlan, "trial">;
  name: string;
  monthlyUsd: number;
  seats: number;
  features: string[];
  usage: PlanUsage;
}

export const BILLING_PLANS: BillingPlan[] = [
  {
    plan: "starter",
    name: "Starter",
    monthlyUsd: 149,
    seats: 3,
    features: ["ACE + ACI e-manifests", "Registries & expiry alerts", "3 users"],
    usage: {
      includedDocuments: 50,
      includedCopilotMessages: 200,
      overageUsdPerDocument: 1.5,
      overageUsdPerMessage: 0.1,
    },
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
    usage: {
      includedDocuments: 500,
      includedCopilotMessages: 2000,
      overageUsdPerDocument: 1.0,
      overageUsdPerMessage: 0.05,
    },
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
    // Unlimited: an enterprise agreement prices volume up front, so the meter
    // is informational and never produces an overage line.
    usage: {
      includedDocuments: null,
      includedCopilotMessages: null,
      overageUsdPerDocument: 0,
      overageUsdPerMessage: 0,
    },
  },
];

/**
 * The allowance a plan is metered against. `trial` has no plan row of its own —
 * it is metered against Starter, the plan a trial converts into.
 */
export function planUsageFor(plan: SubscriptionPlan): PlanUsage {
  return (BILLING_PLANS.find((p) => p.plan === plan) ?? BILLING_PLANS[0]!).usage;
}

/**
 * The seat allowance a plan advertises. Like `planUsageFor`, `trial` has no
 * plan row of its own, so it is metered against Starter, the plan a trial
 * converts into. An organization's actual `subscriptions.seats` (the real
 * Stripe subscription quantity, which can exceed the plan default) takes
 * precedence over this wherever a live subscription exists.
 */
export function seatsForPlan(plan: SubscriptionPlan): number {
  return (BILLING_PLANS.find((p) => p.plan === plan) ?? BILLING_PLANS[0]!).seats;
}

const METER_ENV_PREFIX = "STRIPE_METER_";

export interface StripeEnv {
  secretKey?: string;
  webhookSecret?: string;
  /** Stripe Price IDs per plan, e.g. STRIPE_PRICE_STARTER */
  prices?: Partial<Record<BillingPlan["plan"], string>>;
  /**
   * Stripe meter `event_name` per metric, keyed by the lower-cased metric.
   * Read from `STRIPE_METER_<METRIC>` (e.g. STRIPE_METER_DOCUMENTS_EXTRACTED);
   * a metric with no override meters under its own name.
   */
  meters?: Record<string, string>;
}

export function readStripeEnv(env: NodeJS.ProcessEnv = process.env): StripeEnv {
  const meters: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(METER_ENV_PREFIX) && value) {
      meters[key.slice(METER_ENV_PREFIX.length).toLowerCase()] = value;
    }
  }
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    prices: {
      starter: env.STRIPE_PRICE_STARTER,
      professional: env.STRIPE_PRICE_PROFESSIONAL,
      enterprise: env.STRIPE_PRICE_ENTERPRISE,
    },
    meters,
  };
}

/** Stripe meter `event_name` for a metric — the env override, else the metric. */
export function meterEventNameFor(metric: string, env: StripeEnv = readStripeEnv()): string {
  return env.meters?.[metric.toLowerCase()] ?? metric;
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
  /** Stable per-attempt id (the router mints one per call and audits it) — the Stripe idempotency key. */
  attemptId: string;
}

export async function createCheckout(
  input: CheckoutInput,
  env: StripeEnv = readStripeEnv(),
  stripe: Stripe | null = stripeClient(env),
) {
  if (!stripe) {
    // mock: the app's own route activates the plan and redirects back
    const u = new URL(input.successUrl);
    u.searchParams.set("mock_checkout", input.plan);
    return { mode: "mock" as const, url: u.toString() };
  }
  const price = env.prices?.[input.plan];
  if (!price) throw new Error(`Missing Stripe price id for plan ${input.plan}`);
  const session = await stripe.checkout.sessions.create(
    {
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
    },
    { idempotencyKey: `corridor_checkout_${input.attemptId}` },
  );
  return { mode: "stripe" as const, url: session.url! };
}

export interface PortalInput {
  customerId: string;
  returnUrl: string;
  /** Stable per-attempt id (the router mints one per call and audits it) — the Stripe idempotency key. */
  attemptId: string;
}

export async function createPortal(
  input: PortalInput,
  env: StripeEnv = readStripeEnv(),
  stripe: Stripe | null = stripeClient(env),
) {
  if (!stripe) return { mode: "mock" as const, url: input.returnUrl };
  const session = await stripe.billingPortal.sessions.create(
    { customer: input.customerId, return_url: input.returnUrl },
    { idempotencyKey: `corridor_portal_${input.attemptId}` },
  );
  return { mode: "stripe" as const, url: session.url };
}

/** One metered event to push to Stripe. */
export interface UsageMeterRecord {
  /** usage_records.id — also the Stripe idempotency identifier. */
  id: number;
  organizationId: string;
  metric: string;
  quantity: number;
  occurredAt: Date;
  /** The organization's Stripe customer, when it has one. */
  stripeCustomerId: string | null;
}

export interface UsageMeterResult {
  id: number;
  eventId: string;
  /**
   * `stripe`   — accepted by a Stripe meter.
   * `mock`     — no STRIPE_SECRET_KEY; synthetic id so the record still settles.
   * `unbilled` — Stripe is configured but the organization has no customer to
   *              bill (it never checked out). Stamped and settled rather than
   *              retried forever; the local meter keeps the number for the UI.
   * `failed`   — Stripe rejected this one record; it stays unstamped and is
   *              retried next run. The rest of the batch still settles.
   */
  mode: "stripe" | "mock" | "unbilled" | "failed";
  error?: string;
}

/**
 * Push metered events to Stripe. Degrades gracefully: with no secret key every
 * record comes back with a synthetic `mock_<uuid>` id so the reporter job can
 * still stamp and settle it.
 *
 * `identifier` is the local record id, which makes the call idempotent — a
 * retried job cannot double-bill an event Stripe already accepted.
 */
export async function reportUsage(
  records: UsageMeterRecord[],
  env: StripeEnv = readStripeEnv(),
  stripe: Stripe | null = stripeClient(env),
): Promise<UsageMeterResult[]> {
  if (!stripe) {
    return records.map((r) => ({ id: r.id, eventId: `mock_${randomUUID()}`, mode: "mock" }));
  }
  const out: UsageMeterResult[] = [];
  for (const record of records) {
    if (!record.stripeCustomerId) {
      out.push({ id: record.id, eventId: `unbilled_${randomUUID()}`, mode: "unbilled" });
      continue;
    }
    const identifier = `corridor_usage_${record.id}`;
    try {
      await stripe.billing.meterEvents.create({
        event_name: meterEventNameFor(record.metric, env),
        identifier,
        timestamp: Math.floor(record.occurredAt.getTime() / 1000),
        payload: {
          value: String(record.quantity),
          stripe_customer_id: record.stripeCustomerId,
        },
      });
      out.push({ id: record.id, eventId: identifier, mode: "stripe" });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[stripe] meter event ${identifier} failed`, e);
      out.push({ id: record.id, eventId: identifier, mode: "failed", error });
    }
  }
  return out;
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
