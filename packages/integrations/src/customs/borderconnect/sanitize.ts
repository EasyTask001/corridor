/**
 * Turns one BorderConnect inbound message into a structure-preserving
 * fixture: every key and array shape survives, but every value is either a
 * canonical routing identifier, a fixed date, a structural/enum field
 * `parseInbound()` branches on, or a `<redacted:len=N>` placeholder. Unlike
 * `redactedSmokeRecord` (smoke-support.ts), which collapses a message to an
 * envelope + hashes for pilot-log evidence, this keeps the full shape so the
 * output is usable as a `parseInbound()` regression fixture.
 *
 * Deterministic and idempotent: sanitizing an already-sanitized message (or
 * one of the existing hand-written fixtures) reproduces the same identifiers
 * and leaves an existing `<redacted:len=N>` placeholder untouched rather than
 * re-wrapping it, so running this twice never changes a promoted fixture.
 */

// Same canonical values `inbound.test.ts` already asserts against, so a
// sanitized live fixture reads identically to a hand-written one.
const CANONICAL_IDENTIFIERS: Record<string, string> = {
  companyKey: "c-9000-2bcd8ae5954e0c48",
  tripNumber: "ABCD260912001",
  cargoControlNumber: "1234PARS0001",
  shipmentControlNumber: "1234PARS0001",
  sendId: "SEND-0001",
};

// Fields `parseInbound()` branches on — kept verbatim so the sanitized
// fixture still exercises the same code path as the live message.
const STRUCTURAL_KEYS = new Set([
  "data",
  "status",
  "errorCode",
  "type",
  "code",
  "operation",
  "autoSend",
  "bundleTripAndShipments",
  "messageType",
  "statusCode",
  "responseCode",
]);

const DATE_KEYS = new Set(["cbpDateTime", "cbsaDateTime", "dateTime"]);
const FIXED_EPOCH = "2026-01-01 00:00:00";
const REDACTED_PATTERN = /^<redacted:len=\d+>$/;

function sanitizeString(key: string, value: string): string {
  const identifier = CANONICAL_IDENTIFIERS[key];
  if (identifier !== undefined) return identifier;
  if (DATE_KEYS.has(key)) return FIXED_EPOCH;
  if (STRUCTURAL_KEYS.has(key)) return value;
  if (REDACTED_PATTERN.test(value)) return value;
  return `<redacted:len=${value.length}>`;
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(key, entry));
  if (value !== null && typeof value === "object") {
    return sanitizeNode(value as Record<string, unknown>);
  }
  if (typeof value === "string") return sanitizeString(key, value);
  return value;
}

function sanitizeNode(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = sanitizeValue(key, value);
  return out;
}

export function sanitizeInboundForFixture(message: unknown): unknown {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return message;
  return sanitizeNode(message as Record<string, unknown>);
}
