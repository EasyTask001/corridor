/**
 * Small, regime-agnostic formatting helpers shared by `ace.ts`/`aci.ts`/
 * `send-request.ts`: the trip-number derivation rule and BorderConnect's
 * `"yyyy-mm-dd hh:mm:ss"` local-time-in-a-timezone convention.
 */
import { CustomsTransportError } from "../types";
import type { ManifestPayload } from "../types";

export interface OutboundOptions {
  companyKey: string;
  sendId: string;
  operation: "CREATE" | "UPDATE";
  autoSend: boolean;
  /** Amend/cancel must reuse the trip number already on file (customs_submissions.reference_number). */
  tripNumberOverride?: string;
}

const ACE_TRIP_NUMBER = /^[A-Z]{4}[A-Z0-9]{4,21}$/;
const ACI_TRIP_NUMBER = /^[A-Z0-9-]{4}[A-Z0-9]{4,21}$/;

/** CBSA cargo-control-style numbers avoid O/I (confused with 0/1 in print/OCR). */
function normaliseAci(s: string): string {
  return s.toUpperCase().replace(/O/g, "0").replace(/I/g, "1");
}

/**
 * `m.trip.tripNumber` when it already matches the regime's pattern; otherwise
 * derived from the carrier code + movement number. Throws a 422
 * `CustomsTransportError` when neither candidate fits — callers that want
 * every problem on a manifest reported together (`validateForBorderConnect`)
 * catch this rather than let it escape.
 */
export function tripNumberFor(m: ManifestPayload): string {
  const isAci = m.regime === "ACI";
  const pattern = isAci ? ACI_TRIP_NUMBER : ACE_TRIP_NUMBER;
  const prepare = (s: string): string => (isAci ? normaliseAci(s) : s.toUpperCase());

  const derived = `${m.carrier.code}${m.trip.movementNumber.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`;
  const candidates = [m.trip.tripNumber, derived];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const prepared = prepare(candidate);
    if (pattern.test(prepared)) return prepared;
  }

  throw new CustomsTransportError(
    "trip.tripNumber: must start with the carrier code and be 8–25 alphanumerics",
    422,
    false,
  );
}

/**
 * `Intl.DateTimeFormat("en-CA", {timeZone, hourCycle:"h23", …})` parts →
 * `"YYYY-MM-DD HH:mm:ss"`, with minutes rounded to the nearest 15 (carrying
 * into the hour/day/month/year as needed). BorderConnect's `time-zones.json`
 * list is US abbreviations, not IANA names (see `code-lists.ts`), so this
 * never appends a timezone of its own — callers pass the IANA name they want
 * the wall-clock computed in.
 */
export function bcDateTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(iso));

  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const year = part("year");
  const month = part("month");
  const day = part("day");
  const hour = part("hour");
  const minute = part("minute");

  const roundedMinute = Math.round(minute / 15) * 15;

  // Build the wall-clock reading as if it were UTC so `setUTCMinutes`
  // carries a 60-minute rollover into the hour/day/month/year for free,
  // without Node's own local timezone getting involved.
  const asUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  asUtc.setUTCMinutes(asUtc.getUTCMinutes() + (roundedMinute - minute));

  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${asUtc.getUTCFullYear()}-${pad(asUtc.getUTCMonth() + 1)}-${pad(asUtc.getUTCDate())} ` +
    `${pad(asUtc.getUTCHours())}:${pad(asUtc.getUTCMinutes())}:${pad(asUtc.getUTCSeconds())}`
  );
}
