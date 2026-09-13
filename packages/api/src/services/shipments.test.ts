import { describe, expect, it } from "vitest";
import { createFakeDb, TEST_ORG_ID } from "../test/mock-context";
import { assertBrokerPartner } from "./shipments";

const BROKER_ID = "11111111-1111-4111-8111-111111111111";
const DUAL_ID = "22222222-2222-4222-8222-222222222222";
const SHIPPER_ID = "33333333-3333-4333-8333-333333333333";

describe("assertBrokerPartner", () => {
  const rows = {
    partners: [
      { id: BROKER_ID, organizationId: TEST_ORG_ID, type: "broker" },
      { id: DUAL_ID, organizationId: TEST_ORG_ID, type: "both" },
      { id: SHIPPER_ID, organizationId: TEST_ORG_ID, type: "shipper" },
    ],
  };

  it("accepts broker and dual-role partners", async () => {
    const brokerDb = createFakeDb({ rows: { partners: [rows.partners[0]!] } });
    const dualDb = createFakeDb({ rows: { partners: [rows.partners[1]!] } });
    await expect(assertBrokerPartner(brokerDb.tx, TEST_ORG_ID, BROKER_ID)).resolves.toBeUndefined();
    await expect(assertBrokerPartner(dualDb.tx, TEST_ORG_ID, DUAL_ID)).resolves.toBeUndefined();
    await expect(assertBrokerPartner(brokerDb.tx, TEST_ORG_ID, null)).resolves.toBeUndefined();
  });

  it("rejects an existing partner with the wrong role", async () => {
    const db = createFakeDb({ rows: { partners: [rows.partners[2]!] } });
    await expect(assertBrokerPartner(db.tx, TEST_ORG_ID, SHIPPER_ID)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Selected partner is not a broker",
    });
  });

  it("does not accept a partner outside the tenant", async () => {
    const db = createFakeDb({ rows: { partners: [] } });
    await expect(
      assertBrokerPartner(db.tx, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", BROKER_ID),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Broker not found" });
  });
});
