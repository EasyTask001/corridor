/**
 * CSV import validation against the fake DB: bad enums, an unknown partner,
 * duplicate control numbers (in the file and in the database), the hazmat
 * triplet rule, and a clean file that resolves every code.
 */
import { describe, expect, it } from "vitest";
import { createFakeDb, TEST_ORG_ID } from "../test/mock-context";
import { parseCsv, validateCommodityRows, validateShipmentRows } from "./imports";

const PARTNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BROKER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PORT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHIPMENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const rows = {
  partners: [
    {
      id: PARTNER,
      organizationId: TEST_ORG_ID,
      name: "Maple Ridge Steel Ltd",
      type: "shipper",
      status: "active",
    },
    {
      id: BROKER,
      organizationId: TEST_ORG_ID,
      name: "Northgate Customs Brokers",
      type: "broker",
      status: "active",
    },
  ],
  organizationCarrierCodes: [
    { organizationId: TEST_ORG_ID, regime: "ACE", code: "PFTR", isDefault: true, status: "active" },
    { organizationId: TEST_ORG_ID, regime: "ACI", code: "7ELU", isDefault: true, status: "active" },
  ],
  ports: [{ id: PORT, regime: "ACE", kind: "port_of_entry", code: "3801", active: true }],
  shipments: [
    {
      id: SHIPMENT,
      organizationId: TEST_ORG_ID,
      controlNumber: "PFTRPAPS00001",
      status: "draft",
      movementId: null,
    },
  ],
  movements: [],
  commodities: [],
};

describe("parseCsv", () => {
  it("folds headers and auto-detects the delimiter", () => {
    const { rows: parsed, columns } = parseCsv(
      "Control Reference;Shipper Name\r\nPAPS1;Maple\r\n\r\n",
    );
    expect(columns).toEqual(["control_reference", "shipper_name"]);
    expect(parsed).toEqual([{ control_reference: "PAPS1", shipper_name: "Maple" }]);
  });
});

describe("validateShipmentRows", () => {
  const csv = (lines: string[]) =>
    parseCsv(
      [
        "regime,carrier_code,control_reference,shipment_type,cargo_type,shipper_name,consignee_name,broker_name,entry_port,is_pars",
        ...lines,
      ].join("\n"),
    ).rows;

  it("resolves a clean ACE row and defaults the carrier code", async () => {
    const db = createFakeDb({ rows });
    const { report, payload } = await validateShipmentRows(
      db.tx,
      TEST_ORG_ID,
      csv([
        "ACE,,PAPS90101,regular_bill,,Maple Ridge Steel Ltd,,Northgate Customs Brokers,3801,false",
      ]),
    );
    expect(report).toMatchObject({ okCount: 1, errorCount: 0 });
    expect(payload[0]).toMatchObject({
      carrierCode: "PFTR",
      controlReference: "PAPS90101",
      shipperId: PARTNER,
      brokerId: BROKER,
      entryPortId: PORT,
      shipmentType: "regular_bill",
    });
  });

  it("reports a bad enum first, then an unknown partner and port on the same line", async () => {
    const db = createFakeDb({ rows });
    const { report } = await validateShipmentRows(
      db.tx,
      TEST_ORG_ID,
      csv(["ACE,PFTR,PAPS90102,bogus,,Nobody Inc,,,9999,no"]),
    );
    expect(report.errorCount).toBe(1);
    expect(report.rows[0]?.errors.map((e) => e.column)).toEqual(["shipment_type"]);
    const { report: r2 } = await validateShipmentRows(
      db.tx,
      TEST_ORG_ID,
      csv(["ACE,PFTR,PAPS90102,regular_bill,,Nobody Inc,,,9999,no"]),
    );
    expect(r2.rows[0]?.errors.map((e) => e.column).sort()).toEqual(["entry_port", "shipper_name"]);
  });

  it("refuses an ACI row with an ACE type, and a carrier code the org does not hold", async () => {
    const db = createFakeDb({ rows });
    const { report } = await validateShipmentRows(
      db.tx,
      TEST_ORG_ID,
      csv(["ACI,7ELU,PARS500,regular_bill,,,,,,true", "ACI,ZZZZ,PARS501,,regular,,,,,true"]),
    );
    expect(report.rows[0]?.errors.map((e) => e.column)).toEqual(
      expect.arrayContaining(["cargo_type", "shipment_type"]),
    );
    expect(report.rows[1]?.errors).toEqual([
      { column: "carrier_code", message: "ZZZZ is not one of this organization's ACI codes" },
    ]);
  });

  it("catches duplicates within the file and against the database", async () => {
    const db = createFakeDb({ rows });
    const { report } = await validateShipmentRows(
      db.tx,
      TEST_ORG_ID,
      csv([
        "ACE,PFTR,PAPS90103,regular_bill,,,,,,",
        "ACE,PFTR,PAPS90103,regular_bill,,,,,,",
        "ACE,PFTR,PAPS00001,regular_bill,,,,,,",
      ]),
    );
    expect(report.rows.map((r) => r.status)).toEqual(["ok", "error", "error"]);
    expect(report.rows[1]?.errors[0]?.message).toBe("duplicate of line 2");
    expect(report.rows[2]?.errors[0]?.message).toBe("PFTRPAPS00001 already exists");
  });
});

describe("validateCommodityRows", () => {
  const header =
    "control_number,line_number,description,hs_code,quantity,quantity_unit,weight,weight_unit,country_of_origin,hazmat_code_1,hazmat_description_1,hazmat_contact_1,hazmat_phone_1,value_amount,value_currency";
  const csv = (lines: string[]) => parseCsv([header, ...lines].join("\n")).rows;

  it("resolves the shipment, converts pounds and keeps the hazmat triplet", async () => {
    const db = createFakeDb({ rows });
    const { report, payload } = await validateCommodityRows(
      db.tx,
      TEST_ORG_ID,
      csv([
        "PFTRPAPS00001,1,Steel coils,7208.39,6,Coil,1000,LB,CA,UN1203,Gasoline,Chemtrec,+1 800 424 9300,42000,USD",
      ]),
    );
    expect(report.okCount).toBe(1);
    expect(payload[0]).toMatchObject({
      shipmentId: SHIPMENT,
      weightKg: 453.59,
      weightUnit: "LB",
      hazmat: [{ unCode: "UN1203", description: "Gasoline" }],
    });
  });

  it("flags an unknown shipment, hazmat details without a code, and a value without a currency", async () => {
    const db = createFakeDb({ rows });
    const { report } = await validateCommodityRows(
      db.tx,
      TEST_ORG_ID,
      csv(["PFTRNOPE00001,,Widgets,,1,Box,10,KG,CA,,Flammable,,,500,"]),
    );
    expect(report.rows[0]?.errors.map((e) => e.column).sort()).toEqual([
      "control_number",
      "hazmat_code_1",
      "value_currency",
    ]);
  });
});
