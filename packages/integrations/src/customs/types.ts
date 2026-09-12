import type {
  CrewRole,
  CustomsEventCode,
  DriverDocumentType,
  Gender,
  Regime,
  ShipmentStatus,
} from "@corridor/domain";

/** A shipper/consignee as it is printed on the manifest. */
export interface ManifestParty {
  name: string;
  address: string | null;
  /** The same address, structured — BorderConnect files parts, not one printed line. */
  postal: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
}

export interface ManifestPlate {
  plate: string;
  jurisdiction: string;
}

/** Provider-neutral e-manifest payload built from a movement (see manifest.ts). */
export interface ManifestPayload {
  regime: Regime;
  carrier: {
    /** The movement's own carrier code (migration 0018) — a snapshot, not
     * necessarily the org's current default, since a tenant may file under
     * more than one ACE/ACI code. buildManifest refuses to build a manifest
     * without one. */
    code: string;
    filerCode: string | null;
    usDotNumber: string | null;
    name: string;
    /** SCAC — the org's own, distinct from the movement-level `code` above. */
    scac: string | null;
    canadianCarrierCode: string | null;
    /** The org's operating timezone (organizations.timezone, defaults 'America/Toronto'). */
    timezone: string;
  };
  trip: {
    movementNumber: string;
    tripNumber: string | null;
    portOfEntry: string;
    estimatedArrival: string;
    /** "Empty Trailer" (ACE) / "Empty Trip" (ACI): filed with no shipments. */
    isEmpty: boolean;
    /** Instruments of International Traffic indicator (0022). */
    iitIndicator: "none" | "iit_carrier_bond" | "iit_importer_bond";
    /** CBSA trip flags; all false on ACE. */
    aci: { lvs: boolean; postal: boolean; flyingTruck: boolean; inTransit: boolean; iit: boolean };
  };
  crew: Array<{
    role: CrewRole;
    firstName: string;
    lastName: string;
    gender: Gender | null;
    /** Null for a passenger, who does not drive. */
    licenseNumber: string | null;
    licenseJurisdiction: string | null;
    citizenship: string | null;
    /** ISO date (YYYY-MM-DD), null when not on file. */
    dateOfBirth: string | null;
    hazmatEndorsement: boolean;
    documents: Array<{
      type: DriverDocumentType;
      number: string;
      issuingCountry: string | null;
      issuingState: string | null;
      expiresOn: string | null;
    }>;
  }>;
  conveyance: {
    unitNumber: string;
    vin: string | null;
    plate: string;
    plateJurisdiction: string;
    /** Additional plates (equipment_plates, 0021) — the primary is `plate`. */
    plates: ManifestPlate[];
    /** CBP/BorderConnect conveyance type code (trucks.truck_type, 0047) — defaults 'TR'. */
    truckType: string;
    dotNumber: string | null;
    insurance: {
      company: string | null;
      policyNumber: string | null;
      amount: number | null;
      year: number | null;
    } | null;
    /** A seal on the tractor itself (at most one). */
    seals: string[];
  };
  /** One entry per trailer, in tow order, each with its own seals. */
  equipment: Array<{
    unitNumber: string;
    /** CBP equipment description code (equipment_types.code). */
    type: string;
    plate: string;
    plateJurisdiction: string;
    plates: ManifestPlate[];
    seals: string[];
  }>;
  shipments: Array<{
    controlNumber: string;
    /** ACE files a shipment type, ACI a cargo type — exactly one is set. */
    shipmentType: string | null;
    cargoType: string | null;
    entryNumber: string | null;
    /** CBP port code the entry is filed at. */
    entryPort: string | null;
    inBond: { entryType: string; destinationPort: string | null; number: string | null } | null;
    /** Origin of the goods (shipments.loading_country/province/city, 0047). */
    loading: { country: string | null; province: string | null; city: string | null };
    /** Final delivery place, structured — distinct from the consignee's own address. */
    delivery: ManifestParty["postal"];
    shipper: ManifestParty | null;
    consignee: ManifestParty | null;
    commodities: Array<{
      description: string;
      hsCode: string | null;
      quantity: number | null;
      quantityUnit: string | null;
      weightKg: number | null;
      /** What the user typed the weight in (commodities.weight_unit). */
      weightUnit: "KG" | "LB" | null;
      /** CBP/BorderConnect packaging code (commodities.packaging_type). */
      packagingType: string | null;
      marksAndNumbers: string | null;
      hazmat: Array<{ unCode: string; description: string | null }>;
      countryOfOrigin: string | null;
      value: { amount: number; currency: string } | null;
    }>;
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

/** One message the gateway sent back (0022) — becomes a `customs_event` row. */
export interface CustomsEventMessage {
  code: CustomsEventCode;
  label: string;
  occurredAt: string;
  referenceNumber?: string | null;
  entryNumber?: string | null;
  entryPortCode?: string | null;
  /** Set when the message is about one shipment (entry on file, …). */
  shipmentControlNumber?: string | null;
  raw?: Record<string, unknown>;
}

/** Per-shipment outcome carried with a decision. */
export interface CustomsShipmentMessage {
  controlNumber: string;
  status: ShipmentStatus;
  entryNumber?: string | null;
  entryPortCode?: string | null;
}

export interface CustomsDecisionMessage {
  referenceNumber: string;
  decision: CustomsDecision;
  message: string | null;
  /** The messages behind the decision, oldest first. */
  events: CustomsEventMessage[];
  /** What happened to each shipment on the manifest. */
  shipments: CustomsShipmentMessage[];
  raw: Record<string, unknown>;
}

/** GET /manifests/{ref}: where the filing stands right now. */
export interface CustomsStatusMessage {
  referenceNumber: string;
  status: "pending" | "accepted" | "rejected" | "released" | "held" | "cancelled";
  /** The decision implied by `status`, null while pending or cancelled. */
  decision: CustomsDecision | null;
  message: string | null;
  events: CustomsEventMessage[];
  shipments: CustomsShipmentMessage[];
  raw: Record<string, unknown>;
}

/** A status document pushed by the gateway, with the id that makes it idempotent. */
export interface InboundCustomsMessage extends CustomsStatusMessage {
  eventId: string;
}

/** A CBP/CBSA service notice as the gateway relays it (carrier_notices). */
export interface CarrierNotice {
  provider: "cbp_ace" | "cbsa_aci";
  externalId: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string | null;
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string;
}

export interface CustomsCancelAck {
  referenceNumber: string;
  receivedAt: string;
  raw: Record<string, unknown>;
}

export type CustomsClientMode = "mock" | "gateway";

/** An in-bond move as CBP wants to hear about it (0026). */
export interface InBondMessage {
  bondNumber: string;
  entryType: "IT" | "TE" | "IE";
  arrivalPortCode: string;
  exportPortCode: string;
  firmsCode: string;
  carrierCode: string | null;
  /** Our control number, or the originating carrier's for an external shipment. */
  controlNumber: string | null;
}

export interface InBondAck {
  referenceNumber: string;
  receivedAt: string;
  raw: Record<string, unknown>;
}

export interface InBondStatusMessage {
  bondNumber: string;
  status: "open" | "arrived" | "exported" | "cancelled" | "unknown";
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
  readonly mode: CustomsClientMode;
  /** Submit a manifest. Throws CustomsTransportError on gateway failure. */
  transmit(manifest: ManifestPayload, opts?: { correlationId?: string }): Promise<TransmitAck>;
  /** Re-file an accepted manifest with changes. */
  amend(
    manifest: ManifestPayload,
    referenceNumber: string,
    opts?: { correlationId?: string },
  ): Promise<TransmitAck>;
  /** Withdraw a filed manifest. */
  cancel(referenceNumber: string, reason: string | null): Promise<CustomsCancelAck>;
  /**
   * Fetch the decision for a reference. Mock providers derive it
   * deterministically; real providers poll or receive a callback.
   */
  fetchDecision(
    referenceNumber: string,
    manifest: ManifestPayload,
    ctx: { currentStatus: "sent" | "accepted" | "held" },
  ): Promise<CustomsDecisionMessage>;
  /** Where the filing stands now (the polling primitive). */
  fetchStatus(referenceNumber: string): Promise<CustomsStatusMessage>;
  /** Carrier service notices published since `since` (all when null). */
  fetchNotices(since: Date | null): Promise<CarrierNotice[]>;
  /** Verify and parse a webhook delivery; null when the signature fails. */
  parseInbound(
    rawBody: string,
    headers: { get(name: string): string | null },
    secret?: string | null,
  ): InboundCustomsMessage | null;
  /** Connection test for the integrations page. */
  ping(): Promise<{ ok: boolean; mode: CustomsClientMode; live: boolean; detail: unknown }>;
  /** In-bond messages (0026): arrival at the port, export, cancellation, and a status check. */
  inBondArrival(rec: InBondMessage): Promise<InBondAck>;
  inBondExport(rec: InBondMessage): Promise<InBondAck>;
  inBondCancel(rec: InBondMessage, reason: string | null): Promise<InBondAck>;
  inBondStatus(bondNumber: string): Promise<InBondStatusMessage>;
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
