import type { Regime } from "@corridor/domain";

/** Provider-neutral e-manifest payload built from a movement (see manifest.ts). */
export interface ManifestPayload {
  regime: Regime;
  carrier: {
    /** The movement's own carrier code (migration 0018) — a snapshot, not
     * necessarily the org's current default, since a tenant may file under
     * more than one ACE/ACI code. */
    code: string | null;
    filerCode: string | null;
    usDotNumber: string | null;
    name: string;
  };
  trip: {
    movementNumber: string;
    tripNumber: string | null;
    portOfEntry: string;
    estimatedArrival: string;
  };
  crew: Array<{
    role: "driver";
    firstName: string;
    lastName: string;
    licenseNumber: string;
    licenseJurisdiction: string;
    citizenship: string | null;
    fastCardNumber: string | null;
  }>;
  conveyance: { unitNumber: string; vin: string | null; plate: string; plateJurisdiction: string };
  equipment: Array<{
    unitNumber: string;
    plate: string;
    plateJurisdiction: string;
    seals: string[];
  }>;
  shipments: Array<{
    lineNumber: number;
    shipper: string | null;
    consignee: string | null;
    commodity: string;
    hsCode: string | null;
    weightKg: number | null;
    pieceCount: number | null;
    value: { amount: number; currency: string } | null;
    countryOfOrigin: string | null;
  }>;
}

export type CustomsDecision = "accepted" | "rejected" | "released" | "held";

/** Synchronous acknowledgement from the customs gateway. */
export interface TransmitAck {
  referenceNumber: string;
  receivedAt: string;
  /** milliseconds until the provider's asynchronous decision is expected */
  decisionEtaMs: number;
  /** the provider's raw response, persisted in integration_events */
  raw: Record<string, unknown>;
}

export interface CustomsDecisionMessage {
  referenceNumber: string;
  decision: CustomsDecision;
  message: string | null;
  raw: Record<string, unknown>;
}

export class CustomsTransportError extends Error {
  override readonly name = "CustomsTransportError";
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface CustomsClient {
  readonly provider: "cbp_ace" | "cbsa_aci";
  readonly environment: "sandbox" | "production";
  /** Submit a manifest. Throws CustomsTransportError on gateway failure. */
  transmit(manifest: ManifestPayload, opts?: { correlationId?: string }): Promise<TransmitAck>;
  /**
   * Fetch the decision for a reference. Mock providers derive it
   * deterministically; real providers poll or receive a callback.
   */
  fetchDecision(
    referenceNumber: string,
    manifest: ManifestPayload,
    ctx: { currentStatus: "sent" | "accepted" | "held" },
  ): Promise<CustomsDecisionMessage>;
}

export interface CustomsClientSettings {
  /** delay before the asynchronous decision (mock) */
  mockDelayMs?: number;
  /** 0..1 probability of a transport failure on transmit (mock) */
  mockFailureRate?: number;
}

/**
 * Gateway credentials, decrypted from Supabase Vault immediately before a call
 * (see `read_integration_secret` / services/customs.ts). These values must
 * never reach `integration_events`, `audit_log`, a log line or the browser —
 * clients may only report *whether* they were present.
 */
export interface CustomsCredentials {
  apiKey?: string;
  apiSecret?: string;
  accountId?: string;
}

/** True when at least one credential field carries a non-empty value. */
export const hasCustomsCredentials = (credentials?: CustomsCredentials): boolean =>
  Object.values(credentials ?? {}).some((v) => typeof v === "string" && v.length > 0);
