import { describe, expect, it } from "vitest";
import {
  canTransitionInBond,
  externalShipmentInput,
  inBondRecordInput,
  inBondSendable,
} from "./inbond";

describe("in-bond inputs", () => {
  it("a record names exactly one parent", () => {
    const shipmentId = "11111111-1111-4111-8111-111111111111";
    const externalShipmentId = "22222222-2222-4222-8222-222222222222";
    expect(inBondRecordInput.safeParse({ shipmentId, entryType: "IT" }).success).toBe(true);
    expect(inBondRecordInput.safeParse({ externalShipmentId, entryType: "TE" }).success).toBe(true);
    expect(inBondRecordInput.safeParse({ entryType: "IT" }).success).toBe(false);
    expect(
      inBondRecordInput.safeParse({ shipmentId, externalShipmentId, entryType: "IT" }).success,
    ).toBe(false);
  });

  it("sending needs the bond, both ports and the FIRMS code", () => {
    const ok = {
      bondNumber: "123456789",
      arrivalPortId: "11111111-1111-4111-8111-111111111111",
      exportPortId: "22222222-2222-4222-8222-222222222222",
      firmsCode: "a123",
    };
    expect(inBondSendable.parse(ok).firmsCode).toBe("A123");
    expect(inBondSendable.safeParse({ ...ok, bondNumber: "12345" }).success).toBe(false);
    expect(inBondSendable.safeParse({ ...ok, firmsCode: null }).success).toBe(false);
    expect(inBondSendable.safeParse({ ...ok, exportPortId: undefined }).success).toBe(false);
  });

  it("an external shipment needs a control number or a bond number", () => {
    expect(externalShipmentInput.safeParse({ regime: "ACE" }).success).toBe(false);
    expect(externalShipmentInput.safeParse({ regime: "ACE", controlNumber: "abcd1234" }).data?.controlNumber).toBe("ABCD1234");
    expect(externalShipmentInput.safeParse({ regime: "ACI", inBondNumber: "987654321" }).success).toBe(true);
  });

  it("the lifecycle runs arrival then export, with cancel from any live state", () => {
    expect(canTransitionInBond("open", "arrival_sent")).toBe(true);
    expect(canTransitionInBond("open", "export_sent")).toBe(false);
    expect(canTransitionInBond("arrived", "export_sent")).toBe(true);
    expect(canTransitionInBond("exported", "cancelled")).toBe(false);
    expect(canTransitionInBond("arrival_sent", "cancelled")).toBe(true);
  });
});
