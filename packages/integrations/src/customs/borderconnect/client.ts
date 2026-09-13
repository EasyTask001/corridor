/**
 * `CustomsClient` over BorderConnect's Service Provider eManifest API — the
 * integration point wrapping `transport.ts` (Task 4), `ace.ts`/`aci.ts`/
 * `send-request.ts` (Task 5) and `inbound.ts` (Task 6) behind the same
 * interface `mock` and `gateway` already implement.
 *
 * BorderConnect has no synchronous decision: `send` only acknowledges that a
 * message was accepted for processing, and every real answer (accepted,
 * held, rejected, released, notices, RNS) arrives later through the shared
 * `customs_inbox` a webhook-less poll of `GET /api/receive` drains (a later
 * task). So `fetchStatus`/`fetchDecision`/`fetchNotices`/`inBond*` — every
 * method that assumes a request/response round trip — are simply not
 * supported here; they throw a 501 naming themselves and pointing at the
 * inbox instead. `parseInbound` returns `null` for the same reason: there is
 * no signed webhook to verify in this mode.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Regime } from "@corridor/domain";
import { borderConnectQueue } from "../fixture-state";
import { fixtureOutcomeFor } from "../gateway/client";
import type { CustomsCancelAck, CustomsClient, ManifestPayload, TransmitAck } from "../types";
import { CustomsTransportError } from "../types";
import { toAceTrip } from "./ace";
import { toAciTrip } from "./aci";
import type { OutboundOptions } from "./format";
import { toCancelSendRequest } from "./send-request";
import {
  createBorderConnectHttpTransport,
  type BorderConnectTransport,
} from "./transport";

export interface BorderConnectClientOptions {
  provider: "cbp_ace" | "cbsa_aci";
  environment?: "sandbox" | "production";
  /** BorderConnect's per-company API URL suffix. Null/live gates on this + `apiKey`. */
  apiUrlSuffix: string | null;
  apiKey: string | null;
  /** Sent on every outbound message (trip + every nested shipment, and send-requests). */
  companyKey: string | null;
  /** Injected in tests; otherwise derived from apiUrlSuffix/apiKey or the fixture queue. */
  transport?: BorderConnectTransport;
  now?: () => Date;
  /**
   * Per-tenant fixture partition every other client mode uses (the
   * organization id in production); never sent live. BorderConnect is the one
   * mode that does NOT partition its fixture queue by it — see
   * `FIXTURE_BORDERCONNECT_TENANT_KEY` — but the field stays on the options so
   * `createCustomsClient` can pass the same shape to all three modes.
   */
  tenantKey: string;
}

/**
 * The single fixture-queue partition every BorderConnect client shares.
 *
 * BorderConnect's real model is one shared Service Provider inbox for the
 * whole deployment — `GET /api/receive` is not per-org, messages are told
 * apart by the `companyKey` inside them — so the fixture queue must be shared
 * too. Keying it per organization would split the offline round trip in half:
 * an org-scoped client (`customsClientFor` passes `tenantKey: orgId`) would
 * enqueue its ack under the org's id while the drain
 * (`resolveTransport`, packages/api/src/services/borderconnect.ts), which has
 * no organization at all, reads this fixed key — so transmit → drain could
 * never connect in fixture mode.
 */
export const FIXTURE_BORDERCONNECT_TENANT_KEY = "system";

/**
 * BorderConnect's deployment-wide credentials are shared by every org, so
 * `environment` (per-org, Settings → Organization) — not just whether the
 * deployment happens to have `apiUrlSuffix`/`apiKey` set — must gate live
 * mode. Otherwise a sandbox org would start filing real ACE/ACI trips the
 * moment any org's BorderConnect account is configured.
 */
export function isBorderConnectLive(opts: {
  environment?: "sandbox" | "production";
  apiUrlSuffix: string | null;
  apiKey: string | null;
}): boolean {
  return opts.environment === "production" && !!(opts.apiUrlSuffix && opts.apiKey);
}

const METHOD_NOT_SUPPORTED = (method: string): CustomsTransportError =>
  new CustomsTransportError(
    `${method} is not supported in border_connect mode — status arrives through the BorderConnect inbox`,
    501,
    false,
  );

const here = dirname(fileURLToPath(import.meta.url));

function loadOutcomeFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(here, "fixtures", "outcomes", `${name}.json`), "utf8"),
  ) as Record<string, unknown>;
}

/**
 * Fixture BorderConnect transport: instead of calling the real
 * `POST /api/send` / `GET /api/receive` endpoints, `send()` drops the
 * outbound message straight into a per-tenant queue (`borderConnectQueue`,
 * `fixture-state.ts`) and immediately enqueues the canned replies a real
 * crossing would eventually push back through the shared inbox — first an
 * `API_RESPONSE` ack (`IMPORTED` for a trip, `TRANSMITTED` for a cancel
 * send-request), then, for a trip, the regime's accepted/held/rejected
 * outcome fixture (`fixtures/outcomes/<regime>-<outcome>.json`). The outcome
 * is keyed off the same control-number-suffix convention as the gateway
 * fixture (`H` held, `R` rejected, anything else accepted) — reusing
 * `fixtureOutcomeFor` from `gateway/client.ts` rather than reimplementing it.
 * `receive()` drains the queue, mirroring a real poll of `GET /api/receive`.
 */
export function createFixtureBorderConnectTransport(
  tenantKey: string,
  now: () => Date,
): BorderConnectTransport {
  const QUEUE_KEY = "inbox";

  const enqueue = (msg: Record<string, unknown>): void => {
    const existing = borderConnectQueue.get(tenantKey, QUEUE_KEY) ?? [];
    borderConnectQueue.set(tenantKey, QUEUE_KEY, [...existing, msg]);
  };

  const stamp = (
    msg: Record<string, unknown>,
    companyKey: string | null,
    sendId: string | null,
    tripNumber: string | null,
  ): Record<string, unknown> => ({
    ...msg,
    companyKey,
    sendId,
    tripNumber,
    receivedAt: now().toISOString(),
  });

  return {
    send: (message) => {
      const dataType = typeof message.data === "string" ? message.data : "";
      const companyKey = typeof message.companyKey === "string" ? message.companyKey : null;
      const sendId = typeof message.sendId === "string" ? message.sendId : null;
      const tripNumber = typeof message.tripNumber === "string" ? message.tripNumber : null;

      if (dataType === "ACE_SEND_REQUEST" || dataType === "ACI_SEND_REQUEST") {
        enqueue(stamp({ data: "API_RESPONSE", status: "TRANSMITTED" }, companyKey, sendId, tripNumber));
        return Promise.resolve({ status: "OK" });
      }

      const isAce = dataType === "ACE_TRIP";
      const shipments = Array.isArray(message.shipments)
        ? (message.shipments as Record<string, unknown>[])
        : [];
      const first = shipments[0];
      const controlNumber = String(
        (isAce ? first?.shipmentControlNumber : first?.cargoControlNumber) ?? "",
      );
      const outcome = fixtureOutcomeFor({ shipments: [{ controlNumber }] });

      enqueue(stamp({ data: "API_RESPONSE", status: "IMPORTED" }, companyKey, sendId, tripNumber));
      enqueue(stamp(loadOutcomeFixture(`${isAce ? "ace" : "aci"}-${outcome}`), companyKey, sendId, tripNumber));

      return Promise.resolve({ status: "OK" });
    },
    receive: () => {
      const existing = borderConnectQueue.get(tenantKey, QUEUE_KEY) ?? [];
      borderConnectQueue.delete(tenantKey, QUEUE_KEY);
      return Promise.resolve(existing);
    },
  };
}

export function createBorderConnectCustomsClient(
  opts: BorderConnectClientOptions,
): CustomsClient & { readonly live: boolean } {
  const now = opts.now ?? (() => new Date());
  const regime: Regime = opts.provider === "cbp_ace" ? "ACE" : "ACI";
  const live = isBorderConnectLive(opts);
  const transport: BorderConnectTransport =
    opts.transport ??
    (live
      ? createBorderConnectHttpTransport({ apiUrlSuffix: opts.apiUrlSuffix!, apiKey: opts.apiKey! })
      : createFixtureBorderConnectTransport(FIXTURE_BORDERCONNECT_TENANT_KEY, now));

  /** A live client cannot file without a real companyKey; the fixture queue
   * doesn't care whose key it is, so it gets a harmless placeholder. */
  function resolveCompanyKey(): string {
    if (live && !opts.companyKey) {
      throw new CustomsTransportError(
        "BorderConnect: companyKey is required to transmit in live mode",
        422,
        false,
      );
    }
    return opts.companyKey ?? "fixture";
  }

  async function send(
    manifest: ManifestPayload,
    operation: OutboundOptions["operation"],
    tripNumberOverride: string | undefined,
    correlationId: string | undefined,
  ): Promise<TransmitAck> {
    const companyKey = resolveCompanyKey();
    const sendId = correlationId ?? randomUUID();
    const outboundOptions: OutboundOptions = {
      companyKey,
      sendId,
      operation,
      autoSend: true,
      ...(tripNumberOverride !== undefined && { tripNumberOverride }),
    };
    const body =
      opts.provider === "cbp_ace"
        ? toAceTrip(manifest, outboundOptions)
        : toAciTrip(manifest, outboundOptions);
    const { status } = await transport.send(body);
    return {
      referenceNumber: body.tripNumber as string,
      receivedAt: now().toISOString(),
      // BorderConnect's real decision arrives through the inbox, not a poll
      // on a timer — Task 8 stops scheduling one for this mode.
      decisionEtaMs: 0,
      raw: { borderConnect: true, live, sendId, status },
    };
  }

  return {
    provider: opts.provider,
    environment: opts.environment ?? "sandbox",
    mode: "border_connect",
    live,

    transmit: (manifest, o) => send(manifest, "CREATE", undefined, o?.correlationId),

    // Re-uploads under the trip number already on file, per BorderConnect's
    // amend rule (full re-upload, operation UPDATE, autoSend true).
    amend: (manifest, referenceNumber, o) =>
      send(manifest, "UPDATE", referenceNumber, o?.correlationId),

    async cancel(referenceNumber, _reason): Promise<CustomsCancelAck> {
      const companyKey = resolveCompanyKey();
      const sendId = randomUUID();
      const body = toCancelSendRequest(regime, referenceNumber, { companyKey, sendId });
      const { status } = await transport.send(body);
      return {
        referenceNumber,
        receivedAt: now().toISOString(),
        raw: { borderConnect: true, live, sendId, status },
      };
    },

    fetchStatus: () => Promise.reject(METHOD_NOT_SUPPORTED("fetchStatus")),
    fetchDecision: () => Promise.reject(METHOD_NOT_SUPPORTED("fetchDecision")),
    fetchNotices: () => Promise.reject(METHOD_NOT_SUPPORTED("fetchNotices")),
    inBondArrival: () => Promise.reject(METHOD_NOT_SUPPORTED("inBondArrival")),
    inBondExport: () => Promise.reject(METHOD_NOT_SUPPORTED("inBondExport")),
    inBondCancel: () => Promise.reject(METHOD_NOT_SUPPORTED("inBondCancel")),
    inBondStatus: () => Promise.reject(METHOD_NOT_SUPPORTED("inBondStatus")),

    // No signed webhook in this mode — every status update arrives through
    // the shared inbox drain, not a per-request callback.
    parseInbound: () => null,

    /**
     * Drains the fixture/live inbox and reports how many messages were
     * waiting. NEVER call this in production: it consumes the queue, so a
     * real "Test connection" click would silently eat messages meant for the
     * inbox drain job. It exists for the fixture path and this module's own
     * tests; Task 10 routes the Settings "Test connection" button at the
     * drain job instead, not at this method.
     */
    async ping() {
      const messages = await transport.receive();
      return { ok: true, mode: "border_connect" as const, live, detail: { messages: messages.length } };
    },
  };
}
