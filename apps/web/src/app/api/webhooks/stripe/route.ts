import { getDb, type DatabaseClient } from "@corridor/db";
import { upsertSubscription, writeSystemAudit } from "@corridor/api";
import {
  parseWebhook,
  snapshotFromStripeSubscription,
  stripeClient,
  type SubscriptionSnapshot,
} from "@corridor/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe → Corridor. Verifies the signature, mirrors subscription state.
 * Card data never reaches this handler (Stripe Checkout/Portal hold it).
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const event = parseWebhook(raw, req.headers.get("stripe-signature"));
  if (!event)
    return Response.json({ error: "invalid signature or Stripe not configured" }, { status: 400 });

  const db = getDb();
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const snap = snapshotFromStripeSubscription(event.data.object);
      if (snap) await sync(db, snap, event.type);
      break;
    }
    case "checkout.session.completed": {
      const session = event.data.object;
      const stripe = stripeClient();
      if (stripe && typeof session.subscription === "string") {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const snap = snapshotFromStripeSubscription(sub);
        if (snap) await sync(db, snap, event.type);
      }
      break;
    }
    default:
      break;
  }
  return Response.json({ received: true });
}

/**
 * Mirror the subscription and record it. There is no user behind a webhook, so
 * the audit row carries a null actor and is written under the service role
 * (`log_audit()` would reject it: nobody is a member of anything here).
 */
async function sync(db: DatabaseClient, snap: SubscriptionSnapshot, eventType: string) {
  await upsertSubscription(db, snap);
  await writeSystemAudit(
    db,
    snap.organizationId,
    "billing.subscription_synced",
    "subscription",
    snap.organizationId,
    null,
    {
      eventType,
      plan: snap.plan,
      status: snap.status,
      seats: snap.seats,
      stripeSubscriptionId: snap.stripeSubscriptionId,
      cancelAtPeriodEnd: snap.cancelAtPeriodEnd,
    },
  );
}
