import { describe, expect, it } from "vitest";
import { toCancelSendRequest } from "./send-request";

describe("toCancelSendRequest", () => {
  it("ACE: CANCEL_TRIP_AND_SHIPMENTS", () => {
    expect(toCancelSendRequest("ACE", "PFTR00001", { companyKey: "CK1", sendId: "SID1" })).toEqual({
      data: "ACE_SEND_REQUEST",
      type: "CANCEL_TRIP_AND_SHIPMENTS",
      tripNumber: "PFTR00001",
      companyKey: "CK1",
      sendId: "SID1",
    });
  });

  it("ACI: CANCEL with bundleTripAndShipments", () => {
    expect(toCancelSendRequest("ACI", "PFTR00007", { companyKey: "CK1", sendId: "SID1" })).toEqual({
      data: "ACI_SEND_REQUEST",
      type: "CANCEL",
      bundleTripAndShipments: true,
      tripNumber: "PFTR00007",
      companyKey: "CK1",
      sendId: "SID1",
    });
  });
});
