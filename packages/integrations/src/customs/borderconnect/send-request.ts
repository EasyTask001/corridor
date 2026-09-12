/** BorderConnect's cancel messages: `ACE_SEND_REQUEST` / `ACI_SEND_REQUEST`. */
import type { Regime } from "@corridor/domain";
import type { OutboundOptions } from "./format";

export function toCancelSendRequest(
  regime: Regime,
  tripNumber: string,
  o: Pick<OutboundOptions, "companyKey" | "sendId">,
): Record<string, unknown> {
  if (regime === "ACE") {
    return {
      data: "ACE_SEND_REQUEST",
      type: "CANCEL_TRIP_AND_SHIPMENTS",
      tripNumber,
      companyKey: o.companyKey,
      sendId: o.sendId,
    };
  }
  return {
    data: "ACI_SEND_REQUEST",
    type: "CANCEL",
    bundleTripAndShipments: true,
    tripNumber,
    companyKey: o.companyKey,
    sendId: o.sendId,
  };
}
