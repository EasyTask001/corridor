/**
 * The public PAPS/PARS lookup (0027). No session, no tenant: the only read is
 * `lookup_shipment_status`, a SECURITY DEFINER function granted to the
 * service role that returns status, port, entry number and timestamps for one
 * carrier code + control number — never who, what or where else. Misses and
 * hits look the same to the caller apart from `found`, and the only thing
 * logged is a hashed IP counter.
 */
import { createHash } from "node:crypto";
import { sql, withServiceRole, type DatabaseClient } from "@corridor/db";
import { TRACKING_RATE_LIMITS, type TrackingLookupInput, type TrackingResult } from "@corridor/domain";
import { checkPublicRateLimit, type RateLimitResult } from "../infra/ratelimit";

/** The client address, hashed: enough to count, useless to identify. */
export function trackingKeyFor(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

/** 10 / minute and 100 / day per address. The stricter of the two wins. */
export async function trackingRateLimit(key: string): Promise<RateLimitResult> {
  const minute = await checkPublicRateLimit(`track:${key}`, TRACKING_RATE_LIMITS.perMinute, 60);
  if (!minute.success) return minute;
  const day = await checkPublicRateLimit(`track:${key}`, TRACKING_RATE_LIMITS.perDay, 24 * 3600);
  return day;
}

type LookupRow = Record<string, unknown> & {
  status: string;
  port_code: string | null;
  port_name: string | null;
  entry_number: string | null;
  updated_at: string | Date;
  released_at: string | Date | null;
};

export async function lookupShipmentStatus(
  db: DatabaseClient,
  input: TrackingLookupInput,
): Promise<TrackingResult> {
  const rows = await withServiceRole(db, (tx) =>
    tx.execute<LookupRow>(
      sql`select * from public.lookup_shipment_status(${input.carrierCode}, ${input.controlNumber})`,
    ),
  );
  const row = rows[0];
  if (!row) return { found: false };
  return {
    found: true,
    status: row.status,
    portCode: row.port_code,
    portName: row.port_name,
    entryNumber: row.entry_number,
    updatedAt: new Date(row.updated_at).toISOString(),
    releasedAt: row.released_at ? new Date(row.released_at).toISOString() : null,
  };
}
