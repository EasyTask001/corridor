/**
 * Mock CBP ACE / CBSA ACI gateway.
 *
 * Deterministic hooks (so tests and demos are reproducible):
 *   trip number contains  FAIL    → transport error on transmit (HTTP 503, retryable)
 *   trip number contains  BADAUTH → transport error (HTTP 401, not retryable)
 *   trip number contains  REJECT  → decision: rejected
 *   trip number contains  HOLD    → accepted, then held (release requires re-check)
 *   otherwise                     → accepted, then released
 *
 * Plus configurable random failure injection (mockFailureRate) and decision
 * delay (mockDelayMs) from integration_configs.settings.
 */
import type {
  CustomsClient,
  CustomsClientSettings,
  CustomsCredentials,
  CustomsDecisionMessage,
  ManifestPayload,
  TransmitAck,
} from "./types";
import { CustomsTransportError, hasCustomsCredentials } from "./types";
import { simulateCustomsEvents } from "./simulate";

export interface MockCustomsOptions extends CustomsClientSettings {
  provider: "cbp_ace" | "cbsa_aci";
  environment?: "sandbox" | "production";
  /**
   * Vault-backed gateway credentials. The mock never authenticates, so it only
   * records whether they were supplied — the values themselves are never read,
   * logged or echoed into the persisted response.
   */
  credentials?: CustomsCredentials;
  /** injectable for tests */
  random?: () => number;
  now?: () => Date;
}

function hashRef(seed: string): string {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).toUpperCase().padStart(7, "0").slice(0, 7);
}

export function createMockCustomsClient(opts: MockCustomsOptions): CustomsClient {
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => new Date());
  const delay = Math.max(0, opts.mockDelayMs ?? 4000);
  const failureRate = Math.min(1, Math.max(0, opts.mockFailureRate ?? 0));
  const prefix = opts.provider === "cbp_ace" ? "ACE" : "ACI";
  const credentialsPresent = hasCustomsCredentials(opts.credentials);

  const hook = (m: ManifestPayload) => (m.trip.tripNumber ?? "").toUpperCase();

  return {
    provider: opts.provider,
    environment: opts.environment ?? "sandbox",

    async transmit(manifest, o) {
      const trip = hook(manifest);
      if (trip.includes("BADAUTH")) {
        throw new CustomsTransportError("Gateway rejected carrier credentials", 401, false);
      }
      if (trip.includes("FAIL") || random() < failureRate) {
        throw new CustomsTransportError(
          "Customs gateway unavailable (simulated outage)",
          503,
          true,
        );
      }
      const receivedAt = now().toISOString();
      const referenceNumber = `${prefix}-${hashRef(manifest.trip.movementNumber + receivedAt)}`;
      return {
        referenceNumber,
        receivedAt,
        decisionEtaMs: delay,
        raw: {
          mock: true,
          provider: opts.provider,
          environment: opts.environment ?? "sandbox",
          correlationId: o?.correlationId ?? null,
          acknowledged: true,
          credentialsPresent,
          manifestLines: manifest.shipments.length,
          crew: manifest.crew.length,
        },
      } satisfies TransmitAck;
    },

    async fetchDecision(referenceNumber, manifest, ctx) {
      const trip = hook(manifest);
      let decision: CustomsDecisionMessage["decision"];
      let message: string | null = null;
      if (ctx.currentStatus === "sent") {
        if (trip.includes("REJECT")) {
          decision = "rejected";
          message = "Manifest rejected: shipment data failed validation (simulated).";
        } else {
          decision = "accepted";
          message = `Manifest accepted by ${prefix} (simulated).`;
        }
      } else if (ctx.currentStatus === "accepted") {
        if (trip.includes("HOLD")) {
          decision = "held";
          message = "Referred for secondary inspection (simulated hold).";
        } else {
          decision = "released";
          message = "Released at primary (simulated).";
        }
      } else {
        decision = "released";
        message = "Released after secondary (simulated).";
      }
      const { events, shipments } = simulateCustomsEvents({
        regime: manifest.regime,
        decision,
        currentStatus: ctx.currentStatus,
        referenceNumber,
        portOfEntry: manifest.trip.portOfEntry,
        shipments: manifest.shipments,
        now,
      });
      return {
        referenceNumber,
        decision,
        message,
        events,
        shipments,
        raw: { mock: true, credentialsPresent, decidedAt: now().toISOString() },
      };
    },
  };
}
