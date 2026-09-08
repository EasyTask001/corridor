/**
 * Customs client over the certified EDI gateway's REST API. With a base URL
 * and API key it talks HTTP (transport.ts); without them it replays the
 * fixtures in ./fixtures (see README.md), keyed by the last character of the
 * first shipment's control number: H → held, R → rejected, anything else →
 * accepted then released.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CUSTOMS_EVENT_LABELS, type CustomsEventCode, type Regime } from "@corridor/domain";
import { simulatedEntryNumber } from "../simulate";
import type {
  CarrierNotice,
  InBondAck,
  InBondMessage,
  CustomsClient,
  CustomsCredentials,
  CustomsDecision,
  CustomsDecisionMessage,
  CustomsStatusMessage,
  ManifestPayload,
  TransmitAck,
} from "../types";
import { parseInboundMessage } from "./inbound";
import {
  fromGatewayInBondStatus,
  fromGatewayNotices,
  fromGatewayStatus,
  toGatewayInBond,
  toGatewayManifest,
} from "./mapping";
import { createFixtureTransport, createHttpTransport, type GatewayTransport } from "./transport";

export interface GatewayClientOptions {
  provider: "cbp_ace" | "cbsa_aci";
  environment?: "sandbox" | "production";
  baseUrl?: string | null;
  apiKey?: string | null;
  credentials?: CustomsCredentials;
  webhookSecret?: string | null;
  /** Injected in tests; otherwise derived from baseUrl/apiKey or the fixtures. */
  transport?: GatewayTransport;
  now?: () => Date;
}

type FixtureOutcome = "accepted" | "held" | "rejected";

/** One stage of a fixture: the status document a poll returns, templated per shipment. */
interface FixtureStage {
  status: string;
  message?: string;
  events?: Array<{ code: CustomsEventCode }>;
  /** Emitted once per shipment on the filing, before `events`. */
  eventsPerShipment?: Array<{ code: CustomsEventCode; withEntry?: boolean }>;
  shipmentStatus?: string;
  withEntry?: boolean;
}

interface Fixture {
  stages: FixtureStage[];
}

const here = dirname(fileURLToPath(import.meta.url));

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8")) as T;
}

/** Which fixture family a manifest replays: the first control number's suffix. */
export function fixtureOutcomeFor(manifest: {
  shipments: Array<{ controlNumber: string }>;
}): FixtureOutcome {
  const suffix = manifest.shipments[0]?.controlNumber.slice(-1).toUpperCase();
  return suffix === "H" ? "held" : suffix === "R" ? "rejected" : "accepted";
}

interface Filing {
  outcome: FixtureOutcome;
  controlNumbers: string[];
  portOfEntry: string | null;
  polls: number;
}

/**
 * The fixture gateway keeps a little state per reference so a poll sequence
 * unfolds like a real crossing: accepted → (held →) released, with the
 * shipments' control numbers and entry numbers filled in from the filing.
 */
const fixtureBonds = new Map<string, "arrived" | "exported" | "cancelled">();

export function createFixtureGatewayTransport(regime: Regime, now: () => Date): GatewayTransport {
  const prefix = regime.toLowerCase();
  const filings = new Map<string, Filing>();
  let seq = 0;
  const ack = () => ({
    referenceNumber: `${regime}-FX${String(++seq).padStart(5, "0")}`,
    receivedAt: now().toISOString(),
  });

  const expand = (reference: string, filing: Filing): Record<string, unknown> => {
    const fixture = loadFixture<Fixture>(`${prefix}-${filing.outcome}`);
    const stage = fixture.stages[Math.min(filing.polls, fixture.stages.length) - 1]!;
    const base = now().getTime();
    let tick = 0;
    const at = () => new Date(base + tick++ * 1000).toISOString();
    const entry = (controlNumber: string) => ({
      entryNumber: simulatedEntryNumber(controlNumber),
      entryPortCode: filing.portOfEntry,
    });
    const events = [
      ...filing.controlNumbers.flatMap((controlNumber) =>
        (stage.eventsPerShipment ?? []).map((e) => ({
          code: e.code,
          label: CUSTOMS_EVENT_LABELS[e.code],
          occurredAt: at(),
          referenceNumber: reference,
          shipmentControlNumber: controlNumber,
          ...(e.withEntry && entry(controlNumber)),
        })),
      ),
      ...(stage.events ?? []).map((e) => ({
        code: e.code,
        label: CUSTOMS_EVENT_LABELS[e.code],
        occurredAt: at(),
        referenceNumber: reference,
      })),
    ];
    const shipments = stage.shipmentStatus
      ? filing.controlNumbers.map((controlNumber) => ({
          controlNumber,
          status: stage.shipmentStatus,
          ...(stage.withEntry && entry(controlNumber)),
        }))
      : [];
    return {
      referenceNumber: reference,
      status: stage.status,
      message: stage.message ?? null,
      events,
      shipments,
      fixture: `${prefix}-${filing.outcome}#${filing.polls}`,
    };
  };

  const file = (body: unknown, reference?: string) => {
    const m = (body ?? {}) as {
      shipments?: Array<{ controlNumber: string }>;
      trip?: { portOfEntry?: string };
    };
    const a = reference ? { referenceNumber: reference, receivedAt: now().toISOString() } : ack();
    filings.set(a.referenceNumber, {
      outcome: fixtureOutcomeFor({ shipments: m.shipments ?? [] }),
      controlNumbers: (m.shipments ?? []).map((s) => s.controlNumber),
      portOfEntry: m.trip?.portOfEntry ?? null,
      polls: 0,
    });
    return a;
  };

  const routes = createFixtureTransport({
    "POST /manifests": (body) => file(body),
    "POST /manifests/*/cancel": () => ack(),
  });
  // In-bond moves: the fixture answers a bond's status with the last message
  // sent about it — shared across instances, like a gateway would.
  const bonds = fixtureBonds;

  return {
    post: (path, body) => {
      // An amendment keeps its reference and starts the decision sequence over.
      const amend = /^\/manifests\/([^/]+)\/amendments$/.exec(path);
      if (amend) return Promise.resolve(file(body, decodeURIComponent(amend[1]!)));
      const inBond = /^\/in-bond\/([^/]+)\/(arrival|export|cancel)$/.exec(path);
      if (inBond) {
        const bond = decodeURIComponent(inBond[1]!);
        bonds.set(bond, inBond[2] === "arrival" ? "arrived" : inBond[2] === "export" ? "exported" : "cancelled");
        return Promise.resolve({ ...ack(), bondNumber: bond, fixture: true });
      }
      return routes.post(path, body);
    },
    get: (path) => {
      if (path === "/manifests/ping") return Promise.resolve({ ok: true, fixture: true });
      const bond = /^\/in-bond\/([^/?]+)$/.exec(path);
      if (bond) {
        const number = decodeURIComponent(bond[1]!);
        return Promise.resolve({ bondNumber: number, status: bonds.get(number) ?? "open", fixture: true });
      }
      if (path.startsWith("/notices")) return Promise.resolve(loadFixture<unknown>("notices"));
      const m = /^\/manifests\/([^/?]+)$/.exec(path);
      if (m) {
        const reference = decodeURIComponent(m[1]!);
        const filing = filings.get(reference) ?? {
          outcome: "accepted" as const,
          controlNumbers: [],
          portOfEntry: null,
          polls: 0,
        };
        filing.polls += 1;
        filings.set(reference, filing);
        return Promise.resolve(expand(reference, filing));
      }
      return Promise.reject(new Error(`no fixture for GET ${path}`));
    },
  };
}

export function createGatewayCustomsClient(opts: GatewayClientOptions): CustomsClient {
  const now = opts.now ?? (() => new Date());
  const regime: Regime = opts.provider === "cbp_ace" ? "ACE" : "ACI";
  const apiKey = opts.apiKey ?? opts.credentials?.apiKey ?? null;
  const live = !!(opts.baseUrl && apiKey);
  const transport =
    opts.transport ??
    (live
      ? createHttpTransport({ baseUrl: opts.baseUrl!, apiKey: apiKey! })
      : createFixtureGatewayTransport(regime, now));

  const ackOf = (json: unknown, fallback: string): TransmitAck => {
    const d = (json ?? {}) as Record<string, unknown>;
    return {
      referenceNumber: typeof d.referenceNumber === "string" ? d.referenceNumber : fallback,
      receivedAt: typeof d.receivedAt === "string" ? d.receivedAt : now().toISOString(),
      // The gateway answers asynchronously; the first poll follows this. The
      // fixture replay answers at once, so polling starts almost immediately.
      decisionEtaMs: live ? 120_000 : 4_000,
      raw: { gateway: true, live, ...d },
    };
  };

  const decisionOf = (s: CustomsStatusMessage): CustomsDecisionMessage => ({
    referenceNumber: s.referenceNumber,
    decision: s.decision ?? "accepted",
    message: s.message,
    events: s.events,
    shipments: s.shipments,
    raw: s.raw,
  });

  const fetchStatus = async (referenceNumber: string): Promise<CustomsStatusMessage> => {
    const json = await transport.get(`/manifests/${encodeURIComponent(referenceNumber)}`);
    const status = fromGatewayStatus(json);
    return { ...status, referenceNumber: status.referenceNumber || referenceNumber };
  };

  return {
    provider: opts.provider,
    environment: opts.environment ?? "sandbox",
    mode: "gateway",

    async transmit(manifest: ManifestPayload, o) {
      const json = await transport.post("/manifests", {
        ...toGatewayManifest(manifest),
        correlationId: o?.correlationId ?? null,
      });
      return ackOf(json, `${regime}-${Date.now().toString(36).toUpperCase()}`);
    },

    async amend(manifest, referenceNumber, o) {
      const json = await transport.post(
        `/manifests/${encodeURIComponent(referenceNumber)}/amendments`,
        { ...toGatewayManifest(manifest), correlationId: o?.correlationId ?? null },
      );
      return ackOf(json, referenceNumber);
    },

    async cancel(referenceNumber, reason) {
      const json = await transport.post(
        `/manifests/${encodeURIComponent(referenceNumber)}/cancel`,
        { reason },
      );
      const d = (json ?? {}) as Record<string, unknown>;
      return {
        referenceNumber,
        receivedAt: typeof d.receivedAt === "string" ? d.receivedAt : now().toISOString(),
        raw: { gateway: true, live, ...d },
      };
    },

    fetchStatus,

    /** Gateway mode never guesses: a decision is whatever the status says now. */
    async fetchDecision(referenceNumber, _manifest, ctx) {
      const status = await fetchStatus(referenceNumber);
      if (!status.decision || status.status === "pending") {
        // Still pending: report the stage the caller is already at, with no
        // events, so the caller keeps polling rather than transitioning.
        const fallback: CustomsDecision = ctx.currentStatus === "sent" ? "accepted" : "released";
        return { ...decisionOf(status), decision: fallback, events: [], shipments: [] };
      }
      return decisionOf(status);
    },

    async fetchNotices(since) {
      const path = since ? `/notices?since=${encodeURIComponent(since.toISOString())}` : "/notices";
      const notices: CarrierNotice[] = fromGatewayNotices(await transport.get(path), opts.provider);
      return notices;
    },

    parseInbound(rawBody, headers, secret) {
      return parseInboundMessage(rawBody, headers, secret ?? opts.webhookSecret ?? undefined);
    },

    async ping() {
      const json = (await transport.get("/manifests/ping")) as Record<string, unknown> | null;
      return { ok: json?.ok === true, mode: "gateway", live, detail: json ?? null };
    },

    inBondArrival: (rec) => inBond("arrival", rec),
    inBondExport: (rec) => inBond("export", rec),
    inBondCancel: (rec, reason) => inBond("cancel", rec, reason),
    async inBondStatus(bondNumber) {
      const json = await transport.get(`/in-bond/${encodeURIComponent(bondNumber)}`);
      return fromGatewayInBondStatus(json, bondNumber);
    },
  };

  async function inBond(
    action: "arrival" | "export" | "cancel",
    rec: InBondMessage,
    reason: string | null = null,
  ): Promise<InBondAck> {
    const json = await transport.post(`/in-bond/${encodeURIComponent(rec.bondNumber)}/${action}`, {
      ...toGatewayInBond(rec),
      ...(action === "cancel" && { reason }),
    });
    const d = (json ?? {}) as Record<string, unknown>;
    return {
      referenceNumber:
        typeof d.referenceNumber === "string" ? d.referenceNumber : `${rec.bondNumber}-${action}`,
      receivedAt: typeof d.receivedAt === "string" ? d.receivedAt : now().toISOString(),
      raw: { gateway: true, live, ...d },
    };
  }
}
