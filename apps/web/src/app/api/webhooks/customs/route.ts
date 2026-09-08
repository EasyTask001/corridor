import { getDb } from "@corridor/db";
import { applyInboundCustomsMessage } from "@corridor/api";
import { parseInboundMessage } from "@corridor/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Customs gateway → Corridor (0023). The body is a status document for one
 * filing; it is authenticated with HMAC-SHA256 over the raw bytes using
 * CUSTOMS_GATEWAY_WEBHOOK_SECRET (hex in X-Corridor-Signature). No secret
 * configured means every delivery is refused — never an open endpoint.
 *
 * The reference number resolves to an organization and a movement through
 * customs_submissions, under the service role (there is no session here);
 * `eventId` makes redelivery idempotent via integration_events.correlation_id.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const message = parseInboundMessage(raw, req.headers, process.env.CUSTOMS_GATEWAY_WEBHOOK_SECRET);
  if (!message) return Response.json({ error: "invalid signature" }, { status: 401 });

  const result = await applyInboundCustomsMessage(getDb(), message);
  if ("reason" in result && result.reason === "unknown reference") {
    return Response.json({ applied: false, error: "unknown reference" }, { status: 404 });
  }
  return Response.json(result);
}
