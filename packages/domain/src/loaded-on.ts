import { z } from "zod";
import { uuid } from "./common";

/**
 * Which physical unit a shipment's cargo rides on — the domain model behind
 * BorderConnect's `loadedOn` field (ACE: on the commodity; ACI: on the
 * shipment). `movementTrailerId` is a `movement_trailers` slot id (a tow
 * position on this trip), never a `trailers.id` — the same distinction
 * `seals.movementTrailerId` already makes. `null` means "unspecified": the
 * filer has not chosen, and the default below applies.
 */
export const loadedOnInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("TRUCK") }),
  z.object({ type: z.literal("TRAILER"), movementTrailerId: uuid }),
]);
export type LoadedOnInput = z.infer<typeof loadedOnInput>;

export const setLoadedOnInput = z.object({ id: uuid, loadedOn: loadedOnInput.nullable() });
export type SetLoadedOnInput = z.infer<typeof setLoadedOnInput>;

/** Same shape as `LoadedOnInput`, minus validation — what a DB row carries. */
export type LoadedOnValue = { type: "TRUCK" } | { type: "TRAILER"; movementTrailerId: string } | null;

/** The units a shipment on this trip could be loaded on, in tow order. */
export interface LoadedOnUnits {
  truckUnitNumber: string | null;
  trailers: Array<{ id: string; unitNumber: string }>;
}

export type ResolvedLoadedOn =
  | { type: "TRUCK" | "TRAILER"; unitNumber: string; explicit: boolean }
  /** More than one trailer is attached and nothing has been chosen. */
  | { type: "ambiguous" }
  /** An explicit trailer id is no longer on this movement (dropped/reassigned). */
  | { type: "stale" };

/**
 * Resolves a shipment's placement the same way BorderConnect's documented
 * default does: an explicit choice wins; otherwise zero trailers means the
 * truck, exactly one trailer is unambiguous, and more than one requires a
 * choice. Shared by the UI, the printed manifest, `validateForTransmit`
 * (movement-validation.ts) and `buildManifest` (customs/manifest.ts) so the
 * default is defined exactly once.
 */
export function resolveLoadedOn(units: LoadedOnUnits, value: LoadedOnValue): ResolvedLoadedOn {
  if (value?.type === "TRUCK") {
    return units.truckUnitNumber
      ? { type: "TRUCK", unitNumber: units.truckUnitNumber, explicit: true }
      : { type: "stale" };
  }
  if (value?.type === "TRAILER") {
    const trailer = units.trailers.find((t) => t.id === value.movementTrailerId);
    return trailer
      ? { type: "TRAILER", unitNumber: trailer.unitNumber, explicit: true }
      : { type: "stale" };
  }
  if (units.trailers.length === 0) {
    return units.truckUnitNumber
      ? { type: "TRUCK", unitNumber: units.truckUnitNumber, explicit: false }
      : { type: "stale" };
  }
  if (units.trailers.length === 1) {
    return { type: "TRAILER", unitNumber: units.trailers[0]!.unitNumber, explicit: false };
  }
  return { type: "ambiguous" };
}
