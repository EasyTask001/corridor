import type { Regime } from "@corridor/domain";
import { createGatewayCustomsClient } from "./gateway/client";
import { createMockCustomsClient } from "./mock";
import type {
  CustomsClient,
  CustomsClientMode,
  CustomsClientSettings,
  CustomsCredentials,
} from "./types";

export * from "./types";
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
  return createMockCustomsClient({
    provider,
    environment: input.environment ?? "sandbox",
    ...input.settings,
    credentials: input.credentials,
    tenantKey: input.tenantKey,
  });
}
