import { getDb } from "@corridor/db";
import { upsertSubscription } from "@corridor/api";
import { parseWebhook, snapshotFromStripeSubscription, stripeClient } from "@corridor/integrations";

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
      if (snap) await upsertSubscription(db, snap);
      break;
    }
    case "checkout.session.completed": {
      const session = event.data.object;
      const stripe = stripeClient();
      if (stripe && typeof session.subscription === "string") {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const snap = snapshotFromStripeSubscription(sub);
        if (snap) await upsertSubscription(db, snap);
      }
      break;
    }
    default:
      break;
  }
  return Response.json({ received: true });
}
