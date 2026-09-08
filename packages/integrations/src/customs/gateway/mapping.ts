/**
 * Provider-neutral REST contract with the certified EDI gateway:
 *
 *   POST /manifests                       → { referenceNumber, receivedAt }
 *   POST /manifests/{ref}/amendments      → { referenceNumber, receivedAt }
 *   POST /manifests/{ref}/cancel          → { referenceNumber, receivedAt }
 *   GET  /manifests/{ref}                 → status document (fromGatewayStatus)
 *   GET  /manifests/ping                  → { ok }
 *   GET  /notices?since=                  → { notices: [...] }
 *   webhook POST                          → status document + eventId
 *
 * Only this file knows the wire shapes; the client works in ManifestPayload /
 * CustomsStatusMessage.
 */
import { CUSTOMS_EVENT_LABELS, customsEventCode, type CustomsEventCode } from "@corridor/domain";
import type {
  CarrierNotice,
  CustomsDecision,
  CustomsEventMessage,
  CustomsShipmentMessage,
  CustomsStatusMessage,
  ManifestPayload,
} from "../types";

/** The manifest as the gateway wants it — today a faithful projection. */
export function toGatewayManifest(m: ManifestPayload): Record<string, unknown> {
  return {
    regime: m.regime,
    carrier: m.carrier,
    trip: m.trip,
    crew: m.crew,
    conveyance: m.conveyance,
    equipment: m.equipment,
    shipments: m.shipments,
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const GATEWAY_STATUS: Record<string, CustomsStatusMessage["status"]> = {
  pending: "pending",
  received: "pending",
  accepted: "accepted",
  rejected: "rejected",
  released: "released",
  held: "held",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const DECISION_OF: Partial<Record<CustomsStatusMessage["status"], CustomsDecision>> = {
  accepted: "accepted",
  rejected: "rejected",
  released: "released",
  held: "held",
};

function eventFrom(raw: unknown): CustomsEventMessage | null {
  const e = obj(raw);
  const parsed = customsEventCode.safeParse(e.code);
  if (!parsed.success) return null;
  const code: CustomsEventCode = parsed.data;
  return {
    code,
    label: str(e.label) ?? CUSTOMS_EVENT_LABELS[code],
    occurredAt: str(e.occurredAt) ?? new Date().toISOString(),
    referenceNumber: str(e.referenceNumber),
    entryNumber: str(e.entryNumber),
    entryPortCode: str(e.entryPortCode),
    shipmentControlNumber: str(e.shipmentControlNumber) ?? str(e.controlNumber),
    raw: e,
  };
}

function shipmentFrom(raw: unknown): CustomsShipmentMessage | null {
  const s = obj(raw);
  const controlNumber = str(s.controlNumber);
  const status = str(s.status);
  if (!controlNumber || !status) return null;
  return {
    controlNumber,
    status: status as CustomsShipmentMessage["status"],
    entryNumber: str(s.entryNumber),
    entryPortCode: str(s.entryPortCode),
  };
}

/** GET /manifests/{ref} and the webhook body share this shape. */
export function fromGatewayStatus(json: unknown): CustomsStatusMessage {
  const d = obj(json);
  const status = GATEWAY_STATUS[String(d.status ?? "pending").toLowerCase()] ?? "pending";
  return {
    referenceNumber: str(d.referenceNumber) ?? "",
    status,
    decision: DECISION_OF[status] ?? null,
    message: str(d.message),
    events: arr(d.events)
      .map(eventFrom)
      .filter((e): e is CustomsEventMessage => e !== null),
    shipments: arr(d.shipments)
      .map(shipmentFrom)
      .filter((s): s is CustomsShipmentMessage => s !== null),
    raw: d,
  };
}

export function fromGatewayNotices(json: unknown, provider: "cbp_ace" | "cbsa_aci"): CarrierNotice[] {
  return arr(obj(json).notices ?? json)
    .map(obj)
    .flatMap((n) => {
      const externalId = str(n.id) ?? str(n.externalId);
      const title = str(n.title);
      if (!externalId || !title) return [];
      const sev = String(n.severity ?? "info").toLowerCase();
      return [
        {
          provider,
          externalId,
          severity: sev === "critical" || sev === "warning" ? sev : "info",
          title,
          body: str(n.body),
          startsAt: str(n.startsAt),
          endsAt: str(n.endsAt),
          publishedAt: str(n.publishedAt) ?? new Date().toISOString(),
        } satisfies CarrierNotice,
      ];
    });
}
