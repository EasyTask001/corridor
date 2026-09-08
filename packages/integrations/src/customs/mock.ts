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
  CarrierNotice,
  InBondAck,
  InBondStatusMessage,
  CustomsClient,
  CustomsClientSettings,
  CustomsCredentials,
  CustomsDecisionMessage,
  CustomsStatusMessage,
  ManifestPayload,
  TransmitAck,
} from "./types";
import { CustomsTransportError, hasCustomsCredentials } from "./types";
import { parseInboundMessage } from "./gateway/inbound";
import { simulateCustomsEvents } from "./simulate";

/** The one notice the mock publishes, so the notices flow is testable offline. */
export const MOCK_CARRIER_NOTICE: Omit<CarrierNotice, "provider"> = {
  externalId: "mock-notice-2026-09-01",
  severity: "warning",
  title: "Scheduled ACE/ACI gateway maintenance",
  body: "The e-manifest gateway will be unavailable Sunday 02:00-04:00 ET. Manifests filed in that window are queued and forwarded afterwards.",
  startsAt: "2026-09-14T06:00:00.000Z",
  endsAt: "2026-09-14T08:00:00.000Z",
  publishedAt: "2026-09-01T12:00:00.000Z",
};

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

const mockBonds = new Map<string, InBondStatusMessage["status"]>();

export function createMockCustomsClient(opts: MockCustomsOptions): CustomsClient {
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => new Date());
  const delay = Math.max(0, opts.mockDelayMs ?? 4000);
  const failureRate = Math.min(1, Math.max(0, opts.mockFailureRate ?? 0));
  const prefix = opts.provider === "cbp_ace" ? "ACE" : "ACI";
  const credentialsPresent = hasCustomsCredentials(opts.credentials);

  const hook = (m: ManifestPayload) => (m.trip.tripNumber ?? "").toUpperCase();

  /** In-bond moves the mock has heard about (0026) — shared across instances,
   * since the API builds a fresh client per request. */
  const bonds = mockBonds;

  /** The mock remembers what it acknowledged, so fetchStatus can answer. */
  const filed = new Map<
    string,
    { manifest: ManifestPayload; stage: "sent" | "accepted" | "held" | "done"; cancelled: boolean }
  >();

  const ack = (
    manifest: ManifestPayload,
    o?: { correlationId?: string },
    reference?: string,
  ): TransmitAck => {
    const receivedAt = now().toISOString();
    const referenceNumber =
      reference ?? `${prefix}-${hashRef(manifest.trip.movementNumber + receivedAt)}`;
    filed.set(referenceNumber, { manifest, stage: "sent", cancelled: false });
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
    };
  };

  const client: CustomsClient = {
    provider: opts.provider,
    environment: opts.environment ?? "sandbox",
    mode: "mock",

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
      return ack(manifest, o);
    },

    async amend(manifest, referenceNumber, o) {
      const trip = hook(manifest);
      if (trip.includes("FAIL")) {
        throw new CustomsTransportError("Customs gateway unavailable (simulated outage)", 503, true);
      }
      // The filing keeps its reference; the decision sequence starts over.
      return ack(manifest, o, referenceNumber);
    },

    async cancel(referenceNumber, reason) {
      const f = filed.get(referenceNumber);
      if (f) f.cancelled = true;
      return {
        referenceNumber,
        receivedAt: now().toISOString(),
        raw: { mock: true, cancelled: true, reason },
      };
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
      const f = filed.get(referenceNumber);
      if (f) f.stage = decision === "held" ? "held" : decision === "accepted" ? "accepted" : "done";
      return {
        referenceNumber,
        decision,
        message,
        events,
        shipments,
        raw: { mock: true, credentialsPresent, decidedAt: now().toISOString() },
      };
    },

    /**
     * The mock's view of a filing it acknowledged: each poll advances one
     * stage (sent → accepted → released, or held on the way), like a real
     * gateway answering GET /manifests/{ref}.
     */
    async fetchStatus(referenceNumber) {
      const f = filed.get(referenceNumber);
      const pending: CustomsStatusMessage = {
        referenceNumber,
        status: "pending",
        decision: null,
        message: null,
        events: [],
        shipments: [],
        raw: { mock: true },
      };
      if (!f) return pending;
      if (f.cancelled)
        return { ...pending, status: "cancelled", message: "Cancelled at carrier request (simulated)." };
      if (f.stage === "done")
        return { ...pending, status: "released", decision: "released", message: "Released (simulated)." };
      const d = await client.fetchDecision(referenceNumber, f.manifest, { currentStatus: f.stage });
      const status: CustomsStatusMessage["status"] =
        d.decision === "held"
          ? "held"
          : d.decision === "rejected"
            ? "rejected"
            : d.decision === "released"
              ? "released"
              : "accepted";
      return {
        referenceNumber,
        status,
        decision: d.decision,
        message: d.message,
        events: d.events,
        shipments: d.shipments,
        raw: d.raw,
      };
    },

    async fetchNotices(since) {
      const notice: CarrierNotice = { provider: opts.provider, ...MOCK_CARRIER_NOTICE };
      return !since || new Date(notice.publishedAt) > since ? [notice] : [];
    },

    parseInbound(rawBody, headers, secret) {
      return parseInboundMessage(rawBody, headers, secret ?? undefined);
    },

    async ping() {
      return { ok: true, mode: "mock", live: false, detail: { mock: true, credentialsPresent } };
    },

    // In-bond (0026): the mock acknowledges every message and answers the
    // status of a bond with the last thing it heard about it.
    async inBondArrival(rec) {
      bonds.set(rec.bondNumber, "arrived");
      return inBondAck("ARR", rec.bondNumber);
    },
    async inBondExport(rec) {
      bonds.set(rec.bondNumber, "exported");
      return inBondAck("EXP", rec.bondNumber);
    },
    async inBondCancel(rec, reason) {
      bonds.set(rec.bondNumber, "cancelled");
      return { ...inBondAck("CXL", rec.bondNumber), raw: { mock: true, reason } };
    },
    async inBondStatus(bondNumber) {
      const status = bonds.get(bondNumber) ?? "open";
      const message: InBondStatusMessage = {
        bondNumber,
        status,
        message: `Bond ${bondNumber} is ${status} (simulated).`,
        raw: { mock: true, checkedAt: now().toISOString() },
      };
      return message;
    },
  };
  return client;

  function inBondAck(prefix: string, bondNumber: string): InBondAck {
    const receivedAt = now().toISOString();
    return {
      referenceNumber: `${prefix}-${hashRef(bondNumber + receivedAt)}`,
      receivedAt,
      raw: { mock: true, bondNumber, acknowledged: true },
    };
  }
}
