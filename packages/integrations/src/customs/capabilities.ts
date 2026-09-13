import type { CustomsCapabilities, CustomsClientMode, CustomsCredentials } from "./types";
import { hasCustomsCredentials } from "./types";

const ACI_AMEND_REASON =
  "ACI amendment is disabled until a live CBSA round trip is validated (BORDERCONNECT_ACI_AMEND_ENABLED)";
const BORDERCONNECT_STATUS_REASON = "Status arrives through the shared BorderConnect inbox";
const BORDERCONNECT_IN_BOND_REASON = "QP In-Bond customs messaging coming soon; tracking only.";
const CONFIG_REASON = "Required production customs credentials are not configured";
const MULTI_TRAILER_REASON =
  "Multi-trailer filing (loadedOn) is disabled until a live BorderConnect round trip is validated (BORDERCONNECT_MULTI_TRAILER_ENABLED)";
const EMPTY_TRIP_REASON =
  "Empty-trip filing is disabled until a live BorderConnect round trip is validated (BORDERCONNECT_EMPTY_TRIP_ENABLED)";

export function resolveCustomsCapabilities(input: {
  regime: "ACE" | "ACI";
  mode: CustomsClientMode;
  environment: "sandbox" | "production";
  credentials?: CustomsCredentials;
  baseUrl?: string | null;
  apiKey?: string | null;
  apiUrlSuffix?: string | null;
  companyKey?: string | null;
  aciAmendEnabled?: boolean;
  multiTrailerEnabled?: boolean;
  emptyTripEnabled?: boolean;
}): CustomsCapabilities {
  if (input.mode === "mock") {
    return {
      transmit: true,
      amend: true,
      cancel: true,
      status: true,
      inBond: true,
      multiTrailer: true,
      emptyTrip: true,
      reasons: {},
    };
  }

  if (input.mode === "gateway") {
    const configured =
      input.environment !== "production" ||
      (!!input.baseUrl && !!(input.apiKey || hasCustomsCredentials(input.credentials)));
    return configured
      ? {
          transmit: true,
          amend: true,
          cancel: true,
          status: true,
          inBond: true,
          multiTrailer: true,
          emptyTrip: true,
          reasons: {},
        }
      : {
          transmit: false,
          amend: false,
          cancel: false,
          status: false,
          inBond: false,
          multiTrailer: false,
          emptyTrip: false,
          reasons: {
            transmit: CONFIG_REASON,
            amend: CONFIG_REASON,
            cancel: CONFIG_REASON,
            status: CONFIG_REASON,
            inBond: CONFIG_REASON,
            multiTrailer: CONFIG_REASON,
            emptyTrip: CONFIG_REASON,
          },
        };
  }

  const configured =
    input.environment !== "production" ||
    (!!input.apiUrlSuffix && !!input.apiKey && !!input.companyKey);
  if (!configured) {
    return {
      transmit: false,
      amend: false,
      cancel: false,
      status: false,
      inBond: false,
      multiTrailer: false,
      emptyTrip: false,
      reasons: {
        transmit: CONFIG_REASON,
        amend: CONFIG_REASON,
        cancel: CONFIG_REASON,
        status: BORDERCONNECT_STATUS_REASON,
        inBond: BORDERCONNECT_IN_BOND_REASON,
        multiTrailer: CONFIG_REASON,
        emptyTrip: CONFIG_REASON,
      },
    };
  }

  const amend =
    input.regime === "ACE" || input.environment !== "production" || input.aciAmendEnabled === true;
  const multiTrailer = input.environment !== "production" || input.multiTrailerEnabled === true;
  const emptyTrip = input.environment !== "production" || input.emptyTripEnabled === true;
  return {
    transmit: true,
    amend,
    cancel: true,
    status: false,
    inBond: false,
    multiTrailer,
    emptyTrip,
    reasons: {
      ...(!amend && { amend: ACI_AMEND_REASON }),
      status: BORDERCONNECT_STATUS_REASON,
      inBond: BORDERCONNECT_IN_BOND_REASON,
      ...(!multiTrailer && { multiTrailer: MULTI_TRAILER_REASON }),
      ...(!emptyTrip && { emptyTrip: EMPTY_TRIP_REASON }),
    },
  };
}
