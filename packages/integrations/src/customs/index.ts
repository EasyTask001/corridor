import type { Regime } from "@corridor/domain";
import { createMockCustomsClient } from "./mock";
import type { CustomsClient, CustomsClientSettings, CustomsCredentials } from "./types";

export * from "./types";
export * from "./manifest";
export { createMockCustomsClient } from "./mock";

export const providerForRegime = (regime: Regime): "cbp_ace" | "cbsa_aci" =>
  regime === "ACE" ? "cbp_ace" : "cbsa_aci";

/**
 * Resolve a customs client for an org. Production adapters (real CBP/CBSA
 * gateways) plug in here later; until then every environment uses the mock.
 */
export function createCustomsClient(input: {
  regime: Regime;
  environment?: "sandbox" | "production";
  settings?: CustomsClientSettings;
  /** Vault-decrypted gateway credentials, when the org has stored any. */
  credentials?: CustomsCredentials;
}): CustomsClient {
  return createMockCustomsClient({
    provider: providerForRegime(input.regime),
    environment: input.environment ?? "sandbox",
    ...input.settings,
    credentials: input.credentials,
  });
}
export { simulateCustomsEvents, simulatedEntryNumber } from "./simulate";
