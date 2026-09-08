/**
 * The message sequence a customs gateway sends back for one decision, in the
 * Avaal vocabulary (see CUSTOMS_EVENT_CODES). Shared by the mock gateway and
 * the dev "customs simulation" buttons so both produce the same timeline:
 *
 *   sent      → accepted : sending → preliminary check passed → accepted
 *   sent      → rejected : sending → rejected
 *   accepted  → released : entry on file (per shipment) → arrival recorded → released
 *   accepted  → held     : entry on file (per shipment) → held
 *   held      → released : released
 *
 * ACI reports "entered and released" per shipment instead of an entry on file
 * followed by a release, which is how the RNS wording reads. Entry numbers are
 * derived from the control number so a re-run yields the same number.
 */
import { CUSTOMS_EVENT_LABELS, type CustomsEventCode, type Regime } from "@corridor/domain";
import type { CustomsDecision, CustomsEventMessage, CustomsShipmentMessage } from "./types";

export interface SimulationInput {
  regime: Regime;
  decision: CustomsDecision;
  currentStatus: "sent" | "accepted" | "held";
  referenceNumber: string;
  portOfEntry: string | null;
  shipments: Array<{ controlNumber: string }>;
  now?: () => Date;
}

/** Deterministic 11-digit entry number (CBP style: filer code + check digit shape). */
export function simulatedEntryNumber(controlNumber: string): string {
  let h = 2166136261;
  for (const ch of controlNumber) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `300${String(h % 100_000_000).padStart(8, "0")}`;
}

export function simulateCustomsEvents(input: SimulationInput): {
  events: CustomsEventMessage[];
  shipments: CustomsShipmentMessage[];
} {
  const now = input.now ?? (() => new Date());
  const base = now().getTime();
  let tick = 0;
  const event = (
    code: CustomsEventCode,
    extra: Partial<Omit<CustomsEventMessage, "code" | "label" | "occurredAt">> = {},
  ): CustomsEventMessage => ({
    code,
    label: CUSTOMS_EVENT_LABELS[code],
    occurredAt: new Date(base + tick++ * 1000).toISOString(),
    referenceNumber: input.referenceNumber,
    ...extra,
  });

  const events: CustomsEventMessage[] = [];
  const shipments: CustomsShipmentMessage[] = [];
  const entryFor = (controlNumber: string) => ({
    entryNumber: simulatedEntryNumber(controlNumber),
    entryPortCode: input.portOfEntry,
  });

  if (input.currentStatus === "sent") {
    events.push(event("sending"));
    if (input.decision === "rejected") {
      events.push(event("rejected"));
      for (const s of input.shipments)
        shipments.push({ controlNumber: s.controlNumber, status: "rejected" });
    } else {
      events.push(event("preliminary_check_passed"), event("accepted"));
      for (const s of input.shipments)
        shipments.push({ controlNumber: s.controlNumber, status: "accepted" });
    }
    return { events, shipments };
  }

  if (input.currentStatus === "accepted") {
    for (const s of input.shipments) {
      const entry = entryFor(s.controlNumber);
      if (input.regime === "ACI" && input.decision === "released") {
        events.push(
          event("entered_and_released", { ...entry, shipmentControlNumber: s.controlNumber }),
        );
      } else {
        events.push(event("entry_on_file", { ...entry, shipmentControlNumber: s.controlNumber }));
      }
    }
    if (input.decision === "held") {
      events.push(event("held"));
      for (const s of input.shipments)
        shipments.push({ controlNumber: s.controlNumber, status: "held", ...entryFor(s.controlNumber) });
    } else {
      if (input.regime === "ACE") events.push(event("arrival_recorded"));
      events.push(event("released"));
      for (const s of input.shipments)
        shipments.push({
          controlNumber: s.controlNumber,
          status: "released",
          ...entryFor(s.controlNumber),
        });
    }
    return { events, shipments };
  }

  // held → released
  events.push(event("released"));
  for (const s of input.shipments)
    shipments.push({ controlNumber: s.controlNumber, status: "released" });
  return { events, shipments };
}
