import type { Regime } from "@corridor/domain";
import { createBorderConnectCustomsClient } from "./borderconnect/client";
import { createGatewayCustomsClient } from "./gateway/client";
import { createMockCustomsClient } from "./mock";
import type {
  CustomsClient,
  CustomsClientMode,
  CustomsClientSettings,
  CustomsCredentials,
} from "./types";

export * from "./types";
export { resolveCustomsCapabilities } from "./capabilities";
export * from "./manifest";
export { clearCustomsFixtureState, createFixtureStore, type FixtureStore } from "./fixture-state";
export { createMockCustomsClient, MOCK_CARRIER_NOTICE } from "./mock";
export { rnsFields, simulateCustomsEvents, simulatedEntryNumber } from "./simulate";
export { createGatewayCustomsClient, fixtureOutcomeFor } from "./gateway/client";
export { parseInboundMessage, signInbound, verifyInboundSignature } from "./gateway/inbound";
export { fromGatewayStatus, toGatewayManifest } from "./gateway/mapping";
export {
  createFixtureTransport,
  createHttpTransport,
  isSafeGatewayBaseUrl,
  type GatewayTransport,
} from "./gateway/transport";
export {
  createBorderConnectCustomsClient,
  createFixtureBorderConnectTransport,
  FIXTURE_BORDERCONNECT_TENANT_KEY,
  isBorderConnectLive,
  type BorderConnectClientOptions,
} from "./borderconnect/client";
export { toAceTrip } from "./borderconnect/ace";
export { toAciTrip } from "./borderconnect/aci";
export { validateForBorderConnect } from "./borderconnect/validate";
export { toCancelSendRequest } from "./borderconnect/send-request";
export {
  createBorderConnectHttpTransport,
  normaliseReceiveBody,
  type BorderConnectTransport,
} from "./borderconnect/transport";
export { createBorderConnectSpool, type BorderConnectSpool } from "./borderconnect/spool";
export { parseInbound, inboundKeys, type BorderConnectInbound } from "./borderconnect/inbound";
export {
  isAciReleaseCode,
  ACI_RELEASING_RELEASE_CODES,
  BC_ACI_RELEASE_CODES,
} from "./borderconnect/code-lists";

export const providerForRegime = (regime: Regime): "cbp_ace" | "cbsa_aci" =>
  regime === "ACE" ? "cbp_ace" : "cbsa_aci";

/**
 * Resolve a customs client for an org. `mock` is the deterministic in-process
 * gateway; `gateway` files through the certified EDI gateway's REST API, or
 * replays its fixtures when no base URL / API key is configured (0023).
 */
export function createCustomsClient(input: {
  regime: Regime;
  mode?: CustomsClientMode;
  environment?: "sandbox" | "production";
  settings?: CustomsClientSettings;
  /** Vault-decrypted gateway credentials, when the org has stored any. */
  credentials?: CustomsCredentials;
  baseUrl?: string | null;
  apiKey?: string | null;
  webhookSecret?: string | null;
  /** BorderConnect's per-company API URL suffix (`mode: "border_connect"` only). */
  apiUrlSuffix?: string | null;
  /** BorderConnect's Service Provider company key (`mode: "border_connect"` only). */
  companyKey?: string | null;
  /** Disabled until an end-to-end live CBSA amendment round trip is validated. */
  aciAmendEnabled?: boolean;
  /** Disabled until a live BorderConnect round trip validates loadedOn (0051). */
  multiTrailerEnabled?: boolean;
  /** Disabled until a live BorderConnect round trip validates an empty-trip filing. */
  emptyTripEnabled?: boolean;
  /** Owner of the fixture state (the organization id in production); never sent to a live gateway. */
  tenantKey: string;
}): CustomsClient {
  const provider = providerForRegime(input.regime);
  if (input.mode === "gateway") {
    return createGatewayCustomsClient({
      provider,
      environment: input.environment ?? "sandbox",
      baseUrl: input.baseUrl ?? null,
      apiKey: input.apiKey ?? null,
      credentials: input.credentials,
      webhookSecret: input.webhookSecret ?? null,
      tenantKey: input.tenantKey,
    });
  }
  if (input.mode === "border_connect") {
    return createBorderConnectCustomsClient({
      provider,
      environment: input.environment ?? "sandbox",
      apiUrlSuffix: input.apiUrlSuffix ?? null,
      apiKey: input.apiKey ?? null,
      companyKey: input.companyKey ?? null,
      aciAmendEnabled: input.aciAmendEnabled,
      multiTrailerEnabled: input.multiTrailerEnabled,
      emptyTripEnabled: input.emptyTripEnabled,
      tenantKey: input.tenantKey,
    });
  }
  return createMockCustomsClient({
    provider,
    environment: input.environment ?? "sandbox",
    ...input.settings,
    credentials: input.credentials,
    tenantKey: input.tenantKey,
  });
}
