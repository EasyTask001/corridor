import type { ManifestPayload } from "../types";

/** ACE 1.0.7 / ACI 1.0.6 JSON manuals: loadedOn.number is 1-17 characters of
 * `[A-Z0-9\s-/\\]` — the same pattern the manuals give for the field, distinct
 * from trailers[].number's 15-character cap (contract.ts). */
export const LOADED_ON_NUMBER = /^[A-Z0-9\s\-/\\]{1,17}$/;

/** The wire-level `loadedOn` object for a shipment, or `undefined` when
 * unspecified — the mapper spreads `...(loadedOnWireField(s) ? {loadedOn: …} : {})`
 * so an unset placement never appears on the wire and the provider applies
 * its own documented default (first trailer, else truck). */
export function loadedOnWireField(
  s: ManifestPayload["shipments"][number],
): { type: "TRUCK" | "TRAILER"; number: string } | undefined {
  return s.loadedOn ? { type: s.loadedOn.type, number: s.loadedOn.unitNumber } : undefined;
}
