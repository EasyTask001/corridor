/**
 * Parses the messages BorderConnect's shared queue sends back
 * (`GET /api/receive/[suffix]`, drained by `customs.borderconnect_drain`)
 * into a normalized, typed shape. Pure — no HTTP, no database access. The
 * message's own `data` field is the discriminator (`API_RESPONSE`,
 * `ACE_RESPONSE`, `ACI_RESPONSE`, `ACI_NOTICE`, `RNS_SHIPMENT`,
 * `SYSTEM_ALERT`); anything else, or anything not shaped like an object,
 * comes back as `kind: "unknown"` rather than throwing — a queue this
 * adapter doesn't control must never crash the drain job on one bad message.
 *
 * `ACE_RESPONSE`/`ACI_RESPONSE`/`ACI_NOTICE` all become `kind:
 * "customs_status"`, carrying the exact `CustomsStatusMessage` shape the
 * rest of Corridor already knows how to apply (see
 * `gateway/mapping.ts`'s `fromGatewayStatus` for the sibling function this
 * mirrors for the generic gateway).
 */
import { CUSTOMS_EVENT_LABELS, type CustomsEventCode } from "@corridor/domain";
import type {
  CustomsDecision,
  CustomsEventMessage,
  CustomsShipmentMessage,
  CustomsStatusMessage,
} from "../types";

export type BorderConnectInbound =
  | {
      kind: "api_response";
      companyKey: string | null;
      sendId: string | null;
      ok: boolean;
      status: string;
      message: string;
      errors: string[];
      tripNumber: string | null;
      raw: Record<string, unknown>;
    }
  | {
      kind: "customs_status";
      companyKey: string | null;
      keys: { tripNumber?: string; cargoControlNumber?: string; shipmentControlNumber?: string };
      status: CustomsStatusMessage;
      raw: Record<string, unknown>;
    }
  | {
      kind: "rns";
      cargoControlNumber: string;
      transactionNumber: string | null;
      releaseCode: string | null;
      releaseName: string | null;
      releasedAt: string;
      officeCode: string | null;
      raw: Record<string, unknown>;
    }
  | { kind: "alert"; message: string; raw: Record<string, unknown> }
  | { kind: "unknown"; dataType: string; companyKey: string | null; raw: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Small parsing helpers (same defensive style as gateway/mapping.ts)
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * BorderConnect's inbound timestamps (`cbpDateTime`/`cbsaDateTime`/`dateTime`)
 * are documented as `"yyyy-mm-dd hh:mm:ss"` with no offset. Since the wire
 * format never carries a timezone and CBP/CBSA EDI clocks are conventionally
 * UTC, this treats the wall-clock reading as UTC rather than guessing an
 * organization's timezone (which fetchStatus/parseInbound has no access to —
 * this is pure parsing, no database lookups). A value that already carries
 * an offset or `Z` is passed through `Date` unchanged.
 */
function toIso(raw: string): string {
  const hasOffset = /Z$|[+-]\d{2}:\d{2}$/.test(raw);
  const candidate = hasOffset ? raw : `${raw.replace(" ", "T")}Z`;
  const d = new Date(candidate);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function occurredAt(d: Record<string, unknown>): string {
  const raw = str(d.cbpDateTime) ?? str(d.cbsaDateTime) ?? str(d.dateTime);
  return raw ? toIso(raw) : new Date().toISOString();
}

function makeEvent(
  code: CustomsEventCode,
  occurredAtIso: string,
  overrides: Partial<CustomsEventMessage> = {},
): CustomsEventMessage {
  return {
    code,
    label: CUSTOMS_EVENT_LABELS[code],
    occurredAt: occurredAtIso,
    referenceNumber: null,
    entryNumber: null,
    entryPortCode: null,
    shipmentControlNumber: null,
    raw: {},
    ...overrides,
  };
}

function statusMessage(
  status: CustomsStatusMessage["status"],
  decision: CustomsDecision | null,
  message: string | null,
  events: CustomsEventMessage[],
  shipments: CustomsShipmentMessage[],
  referenceNumber: string,
  raw: Record<string, unknown>,
): CustomsStatusMessage {
  return { referenceNumber, status, decision, message, events, shipments, raw };
}

// ---------------------------------------------------------------------------
// API_RESPONSE
// ---------------------------------------------------------------------------

const API_RESPONSE_OK_STATUSES = new Set(["OK", "QUEUED", "IMPORTED", "TRANSMITTED", "COMPLETED"]);

function parseApiResponse(d: Record<string, unknown>): BorderConnectInbound {
  const status = str(d.status) ?? "";
  const ok = API_RESPONSE_OK_STATUSES.has(status.toUpperCase());
  const errors = arr(d.errors)
    .map(obj)
    .map((e) => {
      const identifier = str(e.identifier);
      const note = str(e.note);
      return identifier && note ? `${identifier}: ${note}` : null;
    })
    .filter((e): e is string => e !== null);
  return {
    kind: "api_response",
    companyKey: str(d.companyKey),
    sendId: str(d.sendId),
    ok,
    status,
    message: errors.join("; "),
    errors,
    tripNumber: str(d.tripNumber),
    raw: d,
  };
}

// ---------------------------------------------------------------------------
// ACE_RESPONSE
// ---------------------------------------------------------------------------

const ACE_HELD_CODES = new Set(["1G", "1H"]);
const ACE_ARRIVAL_CODES = new Set(["11", "12", "13", "19"]);

/** One `shipmentStatusList[]` entry → its event, plus an override for the
 * message-level status/decision when the CBP eManifest code carries one
 * (only 1G/1H, per the mapping table — everything else is events-only). */
function aceShipmentStatusEntry(
  entry: Record<string, unknown>,
  occurredAtIso: string,
): { event: CustomsEventMessage; shipment: CustomsShipmentMessage | null; held: boolean } {
  const code = str(entry.code) ?? "";
  const shipmentControlNumber = str(entry.shipmentControlNumber);
  const entryNumber = str(entry.entryNumber);
  const entryPortCode = str(entry.port);
  const base = { shipmentControlNumber, entryNumber, entryPortCode, raw: entry };

  if (code === "02" || code === "05") {
    return { event: makeEvent("entry_on_file", occurredAtIso, base), shipment: null, held: false };
  }
  if (code === "1C") {
    return {
      event: makeEvent("entered_and_released", occurredAtIso, base),
      shipment: shipmentControlNumber
        ? { controlNumber: shipmentControlNumber, status: "released", entryNumber, entryPortCode }
        : null,
      held: false,
    };
  }
  if (ACE_HELD_CODES.has(code)) {
    return { event: makeEvent("held", occurredAtIso, base), shipment: null, held: true };
  }
  if (ACE_ARRIVAL_CODES.has(code)) {
    return { event: makeEvent("arrival_recorded", occurredAtIso, base), shipment: null, held: false };
  }
  if (code === "1D") {
    return { event: makeEvent("entry_on_file", occurredAtIso, base), shipment: null, held: false };
  }
  return {
    event: makeEvent("preliminary_check_passed", occurredAtIso, {
      ...base,
      raw: { code, description: str(entry.description) },
    }),
    shipment: null,
    held: false,
  };
}

function parseAceResponse(d: Record<string, unknown>): BorderConnectInbound {
  const tripNumber = str(d.tripNumber) ?? "";
  const when = occurredAt(d);
  const companyKey = str(d.companyKey);

  const validationResponses = arr(d.validationResponses).map(obj);
  if (validationResponses.length > 0) {
    const events = validationResponses.map((v) =>
      makeEvent("rejected", when, {
        label: `${str(v.code) ?? ""} – ${str(v.description) ?? ""}`,
        raw: v,
      }),
    );
    const message = validationResponses
      .map((v) => `${str(v.code) ?? ""} – ${str(v.description) ?? ""}`)
      .join("; ");
    return {
      kind: "customs_status",
      companyKey,
      keys: { tripNumber },
      status: statusMessage("rejected", "rejected", message, events, [], tripNumber, d),
      raw: d,
    };
  }

  if (d.processingResponse !== undefined) {
    const event = makeEvent("accepted", when, { raw: obj(d.processingResponse) });
    return {
      kind: "customs_status",
      companyKey,
      keys: { tripNumber },
      status: statusMessage("accepted", "accepted", null, [event], [], tripNumber, d),
      raw: d,
    };
  }

  const tripStatus = str(d.tripStatus);
  if (tripStatus === "AAD" || tripStatus === "19") {
    const event = makeEvent("arrival_recorded", when, { raw: { tripStatus } });
    return {
      kind: "customs_status",
      companyKey,
      keys: { tripNumber },
      status: statusMessage("pending", null, null, [event], [], tripNumber, d),
      raw: d,
    };
  }
  if (tripStatus === "RTR" || tripStatus === "RCO") {
    const event = makeEvent("released", when, { raw: { tripStatus } });
    return {
      kind: "customs_status",
      companyKey,
      keys: { tripNumber },
      status: statusMessage("released", "released", null, [event], [], tripNumber, d),
      raw: d,
    };
  }
  if (tripStatus === "HTR") {
    const event = makeEvent("held", when, { raw: { tripStatus } });
    return {
      kind: "customs_status",
      companyKey,
      keys: { tripNumber },
      status: statusMessage("held", "held", null, [event], [], tripNumber, d),
      raw: d,
    };
  }

  const shipmentStatusList = arr(d.shipmentStatusList).map(obj);
  if (shipmentStatusList.length > 0) {
    const events: CustomsEventMessage[] = [];
    const shipments: CustomsShipmentMessage[] = [];
    let held = false;
    for (const entry of shipmentStatusList) {
      const parsed = aceShipmentStatusEntry(entry, when);
      events.push(parsed.event);
      if (parsed.shipment) shipments.push(parsed.shipment);
      if (parsed.held) held = true;
    }
    return {
      kind: "customs_status",
      companyKey,
      keys: { tripNumber },
      status: held
        ? statusMessage("held", "held", null, events, shipments, tripNumber, d)
        : statusMessage("pending", null, null, events, shipments, tripNumber, d),
      raw: d,
    };
  }

  // ACE_RESPONSE with none of the above shapes recognized — still a
  // customs_status, just with no events (no honest code to assign).
  return {
    kind: "customs_status",
    companyKey,
    keys: { tripNumber },
    status: statusMessage("pending", null, null, [], [], tripNumber, d),
    raw: d,
  };
}

// ---------------------------------------------------------------------------
// ACI_RESPONSE
// ---------------------------------------------------------------------------

function parseAciResponse(d: Record<string, unknown>): BorderConnectInbound {
  const tripNumber = str(d.tripNumber) ?? "";
  const when = occurredAt(d);
  const companyKey = str(d.companyKey);
  const type = str(d.type);

  if (type === "ACCEPT") {
    const event = makeEvent("accepted", when, { raw: d });
    return {
      kind: "customs_status",
      companyKey,
      keys: { tripNumber },
      status: statusMessage("accepted", "accepted", null, [event], [], tripNumber, d),
      raw: d,
    };
  }

  // REJECT (and anything else — an ACI_RESPONSE with no ACCEPT can only be a rejection).
  const errorResponses = arr(d.errorResponses).map(obj);
  const message = errorResponses
    .map((e) => {
      const desc = str(e.errorDescription) ?? str(e.errorText) ?? "";
      return `${str(e.errorCode) ?? ""} ${str(e.errorField) ?? ""}: ${desc}`.trim();
    })
    .join("; ");
  const event = makeEvent("rejected", when, { raw: { errorResponses } });
  return {
    kind: "customs_status",
    companyKey,
    keys: { tripNumber },
    status: statusMessage("rejected", "rejected", message || null, [event], [], tripNumber, d),
    raw: d,
  };
}

// ---------------------------------------------------------------------------
// ACI_NOTICE
// ---------------------------------------------------------------------------

const ACI_NOTICE_EVENT_CODE: Record<string, CustomsEventCode> = {
  MATCHED: "pars_matched",
  NOT_MATCHED: "pars_not_matched",
  CSA_REPORTED: "csa_reported",
  INSUFFICIENT_REVIEW_TIME_WARNING: "review_time_warning",
};

function parseAciNotice(d: Record<string, unknown>): BorderConnectInbound {
  const tripNumber = str(d.tripNumber) ?? "";
  const when = occurredAt(d);
  const companyKey = str(d.companyKey);
  const type = str(d.type) ?? "";

  if (type === "ARRIVAL_REPORTED") {
    const references = arr(d.references).map(obj);
    const events =
      references.length > 0
        ? references.map((r) =>
            makeEvent("arrival_recorded", when, {
              shipmentControlNumber: str(r.cargoControlNumber),
              raw: r,
            }),
          )
        : [makeEvent("arrival_recorded", when, { shipmentControlNumber: str(d.cargoControlNumber), raw: d })];
    return {
      kind: "customs_status",
      companyKey,
      keys: { tripNumber },
      status: statusMessage("pending", null, null, events, [], tripNumber, d),
      raw: d,
    };
  }

  const code = ACI_NOTICE_EVENT_CODE[type];
  const event = makeEvent(code ?? "preliminary_check_passed", when, {
    shipmentControlNumber: str(d.cargoControlNumber),
    raw: d,
  });
  return {
    kind: "customs_status",
    companyKey,
    keys: { tripNumber },
    status: statusMessage("pending", null, null, [event], [], tripNumber, d),
    raw: d,
  };
}

// ---------------------------------------------------------------------------
// RNS_SHIPMENT / SYSTEM_ALERT
// ---------------------------------------------------------------------------

function parseRnsShipment(d: Record<string, unknown>): BorderConnectInbound {
  return {
    kind: "rns",
    cargoControlNumber: str(d.cargoControlNumber) ?? "",
    transactionNumber: str(d.transactionNumber),
    releaseCode: str(d.releaseCode),
    releaseName: str(d.releaseName),
    releasedAt: occurredAt(d),
    officeCode: str(d.officeCode),
    raw: d,
  };
}

function parseSystemAlert(d: Record<string, unknown>): BorderConnectInbound {
  return { kind: "alert", message: str(d.message) ?? "", raw: d };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Parses one BorderConnect inbound message. Never throws — a message this
 * adapter doesn't recognize (or that isn't shaped like an object at all)
 * comes back as `kind: "unknown"`. */
export function parseInbound(msg: unknown): BorderConnectInbound {
  const d = obj(msg);
  const dataType = str(d.data) ?? "";

  switch (dataType) {
    case "API_RESPONSE":
      return parseApiResponse(d);
    case "ACE_RESPONSE":
      return parseAceResponse(d);
    case "ACI_RESPONSE":
      return parseAciResponse(d);
    case "ACI_NOTICE":
      return parseAciNotice(d);
    case "RNS_SHIPMENT":
      return parseRnsShipment(d);
    case "SYSTEM_ALERT":
      return parseSystemAlert(d);
    default:
      return { kind: "unknown", dataType, companyKey: str(d.companyKey), raw: d };
  }
}

/** Routing keys the inbox drain uses to resolve `organization_id` and
 * `customs_submission_id`/`movement_id` before `parseInbound` is even
 * called for correlation. Never throws. */
export function inboundKeys(msg: unknown): {
  dataType: string;
  companyKey: string | null;
  sendId: string | null;
  tripNumber: string | null;
  cargoControlNumber: string | null;
  shipmentControlNumber: string | null;
} {
  const d = obj(msg);
  const references = arr(d.references).map(obj);
  return {
    dataType: str(d.data) ?? "",
    companyKey: str(d.companyKey),
    sendId: str(d.sendId),
    tripNumber: str(d.tripNumber),
    cargoControlNumber: str(d.cargoControlNumber) ?? str(references[0]?.cargoControlNumber),
    shipmentControlNumber: str(d.shipmentControlNumber),
  };
}
