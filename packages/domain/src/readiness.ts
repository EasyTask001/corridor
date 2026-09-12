/**
 * "Ready to cross" rollup (Task 12). Pure, provider-agnostic: given a
 * movement's regime, status, shipments and event history, compute a small
 * set of named checks and an overall `ready` boolean. No DB/API access here
 * — `movement.get` (packages/api/src/router/movement.ts) builds the input
 * from `loadFull` plus a `parsRnsEvents` lookup and calls this.
 */
import type { CustomsEventCode } from "./customs-events";
import type { MovementStatus, Regime } from "./movement";
import type { ShipmentStatus } from "./shipment";

export type ReadinessState = "ok" | "pending" | "blocked";

export interface ReadinessCheck {
  key: string;
  label: string;
  state: ReadinessState;
  detail: string | null;
}

export interface CrossingReadiness {
  ready: boolean;
  checks: ReadinessCheck[];
}

export interface ReadinessShipment {
  controlNumber: string;
  status: ShipmentStatus;
  entryNumber: string | null;
  /** CBSA PARS shipment — drives ACI's `pars_match` / `rns_release` checks. */
  isPars: boolean;
  /** Latest CBSA RNS release time for this shipment, if any (0027 feed). */
  rnsReleasedAt: string | null;
  /**
   * Not in the brief's literal `crossingReadiness` interface — added because
   * the ACE `entries` check rule ("every *non-in-bond* shipment has an entry
   * number...") has no other way to identify an in-bond shipment from the
   * given shape. The caller sets this from `shipmentType === "in_bond"`
   * (always false for ACI, which never has an ACE shipment type). See
   * task-12-report.md for the full reasoning.
   */
  isInBond: boolean;
}

export interface ReadinessEvent {
  code: CustomsEventCode;
  shipmentControlNumber: string | null;
  occurredAt: string;
}

export interface CrossingReadinessInput {
  regime: Regime;
  status: MovementStatus;
  shipments: ReadinessShipment[];
  events: ReadinessEvent[];
}

/** Latest occurredAt (ms epoch) among events matching `codes` (and `controlNumber`, when given). */
function latestTime(
  events: ReadinessEvent[],
  codes: readonly CustomsEventCode[],
  controlNumber?: string,
): number | null {
  let latest: number | null = null;
  for (const e of events) {
    if (!codes.includes(e.code)) continue;
    if (controlNumber !== undefined && e.shipmentControlNumber !== controlNumber) continue;
    const t = Date.parse(e.occurredAt);
    if (latest === null || t > latest) latest = t;
  }
  return latest;
}

const MANIFEST_OK_STATUSES: readonly MovementStatus[] = ["accepted", "released", "arrived"];
const MANIFEST_BLOCKED_STATUSES: readonly MovementStatus[] = ["rejected", "held", "cancelled"];

/** Shared by ACE and ACI — the manifest's own transmit/decision state, not per-shipment. */
function manifestCheck(status: MovementStatus): ReadinessCheck {
  if (MANIFEST_OK_STATUSES.includes(status)) {
    return { key: "manifest", label: "Manifest filed", state: "ok", detail: null };
  }
  if (MANIFEST_BLOCKED_STATUSES.includes(status)) {
    return {
      key: "manifest",
      label: "Manifest filed",
      state: "blocked",
      detail: `Movement is ${status}`,
    };
  }
  return {
    key: "manifest",
    label: "Manifest filed",
    state: "pending",
    detail: status === "sent" ? "Awaiting customs decision" : `Movement is ${status}`,
  };
}

/** ACE — every non-in-bond shipment has an entry number or an entry event. */
function entriesCheck(shipments: ReadinessShipment[], events: ReadinessEvent[]): ReadinessCheck {
  const relevant = shipments.filter((s) => !s.isInBond);
  const missing = relevant.filter((s) => {
    if (s.entryNumber) return false;
    return !events.some(
      (e) =>
        (e.code === "entry_on_file" || e.code === "entered_and_released") &&
        e.shipmentControlNumber === s.controlNumber,
    );
  });
  if (missing.length === 0) {
    return { key: "entries", label: "Entries assigned", state: "ok", detail: null };
  }
  return {
    key: "entries",
    label: "Entries assigned",
    state: "pending",
    detail: `Waiting on entry number for ${missing.length} shipment${missing.length === 1 ? "" : "s"}`,
  };
}

/** ACE — a `held` event with nothing later clearing it (accepted/released) blocks. */
function holdsCheck(events: ReadinessEvent[]): ReadinessCheck {
  const lastClearAt = latestTime(events, ["accepted", "released"]);
  const blocked = events.some(
    (e) => e.code === "held" && (lastClearAt === null || Date.parse(e.occurredAt) > lastClearAt),
  );
  return {
    key: "holds",
    label: "No holds",
    state: blocked ? "blocked" : "ok",
    detail: blocked ? "Movement held for inspection" : null,
  };
}

/** ACE + ACI — the last `rejected` is newer than the last `accepted`. */
function rejectsCheck(events: ReadinessEvent[]): ReadinessCheck {
  const lastAcceptedAt = latestTime(events, ["accepted"]);
  const lastRejectedAt = latestTime(events, ["rejected"]);
  const blocked =
    lastRejectedAt !== null && (lastAcceptedAt === null || lastRejectedAt > lastAcceptedAt);
  return {
    key: "rejects",
    label: "No rejects",
    state: blocked ? "blocked" : "ok",
    detail: blocked ? "Movement rejected by customs" : null,
  };
}

/** ACI — every PARS shipment must have a (still current) `pars_matched` event. */
function parsMatchCheck(shipments: ReadinessShipment[], events: ReadinessEvent[]): ReadinessCheck {
  const parsShipments = shipments.filter((s) => s.isPars);
  let blockedCount = 0;
  let pendingCount = 0;
  for (const s of parsShipments) {
    const matchedAt = latestTime(events, ["pars_matched"], s.controlNumber);
    const notMatchedAt = latestTime(events, ["pars_not_matched"], s.controlNumber);
    if (notMatchedAt !== null && (matchedAt === null || notMatchedAt > matchedAt)) {
      blockedCount += 1;
    } else if (matchedAt === null) {
      pendingCount += 1;
    }
  }
  if (blockedCount > 0) {
    return {
      key: "pars_match",
      label: "PARS matched",
      state: "blocked",
      detail: `${blockedCount} PARS shipment${blockedCount === 1 ? "" : "s"} not matched`,
    };
  }
  if (pendingCount > 0) {
    return {
      key: "pars_match",
      label: "PARS matched",
      state: "pending",
      detail: `Waiting on PARS match for ${pendingCount} shipment${pendingCount === 1 ? "" : "s"}`,
    };
  }
  return { key: "pars_match", label: "PARS matched", state: "ok", detail: null };
}

/** ACI — every PARS shipment must be CBSA RNS-released (or already at `released`). */
function rnsReleaseCheck(shipments: ReadinessShipment[]): ReadinessCheck {
  const parsShipments = shipments.filter((s) => s.isPars);
  const missing = parsShipments.filter((s) => !s.rnsReleasedAt && s.status !== "released");
  if (missing.length === 0) {
    return { key: "rns_release", label: "RNS released", state: "ok", detail: null };
  }
  return {
    key: "rns_release",
    label: "RNS released",
    state: "pending",
    detail: `Waiting on RNS release for ${missing.length} shipment${missing.length === 1 ? "" : "s"}`,
  };
}

/**
 * Compute the ready-to-cross rollup. `isEmpty` is not a separate input field
 * (the brief's interface has none): an empty trip is `shipments.length ===
 * 0`, matching `buildManifest`'s own precondition
 * (`packages/integrations/src/customs/manifest.ts`) that `movement.isEmpty`
 * and `shipments.length === 0` always agree. An empty trip only carries the
 * `manifest` and `rejects` checks — there is nothing to assign an entry to,
 * hold, or PARS-match.
 */
export function crossingReadiness(input: CrossingReadinessInput): CrossingReadiness {
  const isEmpty = input.shipments.length === 0;
  const manifest = manifestCheck(input.status);
  const rejects = rejectsCheck(input.events);

  const checks: ReadinessCheck[] = isEmpty
    ? [manifest, rejects]
    : input.regime === "ACE"
      ? [manifest, entriesCheck(input.shipments, input.events), holdsCheck(input.events), rejects]
      : [manifest, parsMatchCheck(input.shipments, input.events), rnsReleaseCheck(input.shipments), rejects];

  return { ready: checks.every((c) => c.state === "ok"), checks };
}
