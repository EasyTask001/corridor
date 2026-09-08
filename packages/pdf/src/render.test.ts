import { describe, expect, it } from "vitest";
import {
  renderBlankDriverSheets,
  renderDriverSheet,
  renderManifestSummary,
  renderTableReport,
} from "./render";
import type { DriverSheetData } from "./types";

const carrier = {
  name: "Pathfinder Trans Inc",
  legalName: "PATHFINDER TRANS INC",
  carrierCode: "PFTR",
  usDotNumber: "1234567",
  filerCode: null,
};

const sheet: DriverSheetData = {
  carrier,
  trip: {
    regime: "ACE",
    movementNumber: "ACE-26-00042",
    tripNumber: "TRIP-1042",
    status: "accepted",
    portCode: "3801",
    portName: "DETROIT, MI",
    scheduledCrossingAt: "2026-09-08T14:00:00.000Z",
    customsReferenceNumber: "ACE-A7K2Q9",
    isEmpty: false,
    iitIndicator: "none",
    aciFlags: [],
  },
  crew: [
    {
      role: "person_in_charge",
      name: "Gurpreet Singh",
      personType: "driver",
      licenseNumber: "S1234-56789-01234",
      licenseJurisdiction: "ON",
      citizenship: "CA",
      documents: [{ type: "fast", number: "FAST-77014", expiresOn: "2029-01-01" }],
    },
  ],
  truck: { unitNumber: "T-101", plates: ["AB12345 ON", "AB12345M MI"], seals: ["SL-100236"], vin: "1FUJGLDR5CSBP8834" },
  trailers: [
    { unitNumber: "TR-501", plates: ["TRL5011 ON"], seals: ["SL-100231", "SL-100234"], type: "TF" },
    { unitNumber: "TR-502", plates: ["TRL5022 ON"], seals: ["SL-100235"], type: "RT" },
  ],
  shipments: [
    {
      controlNumber: "PFTRPAPS00001",
      kind: "regular_bill",
      entryNumber: "30012345678",
      entryPortCode: "3801",
      status: "released",
      shipper: "Maple Ridge Steel Ltd",
      consignee: "Great Lakes Fabrication Inc",
      inBond: null,
      commodities: [
        {
          line: 1,
          description: "Hot-rolled steel coils",
          hsCode: "7208.39",
          quantity: 6,
          quantityUnit: "Coil",
          weightKg: 18000,
          countryOfOrigin: "CA",
          hazmat: [],
        },
      ],
    },
  ],
  customsEvents: [
    { label: "Accepted", occurredAt: "2026-09-08T12:00:00.000Z", detail: null },
    { label: "Entry on file", occurredAt: "2026-09-08T12:05:00.000Z", detail: "PFTRPAPS00001 · 30012345678 @ 3801" },
  ],
  generatedAt: "2026-09-08T12:10:00.000Z",
  simple: false,
};

const isPdf = (buf: Buffer) => buf.subarray(0, 5).toString("latin1") === "%PDF-";

describe("pdf templates", () => {
  it("driver sheet (full and simple) renders a PDF", async () => {
    const full = await renderDriverSheet(sheet);
    expect(isPdf(full)).toBe(true);
    expect(full.length).toBeGreaterThan(1024);
    const simple = await renderDriverSheet({ ...sheet, simple: true });
    expect(isPdf(simple)).toBe(true);
    expect(simple.length).toBeLessThan(full.length + 1);
  });

  it("manifest summary renders a PDF, with an empty trip too", async () => {
    const buf = await renderManifestSummary(sheet);
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1024);
    const empty = await renderManifestSummary({
      ...sheet,
      trip: { ...sheet.trip, isEmpty: true },
      shipments: [],
      trailers: [],
      customsEvents: [],
    });
    expect(isPdf(empty)).toBe(true);
  });

  it("blank driver sheets render one page per trip number", async () => {
    const buf = await renderBlankDriverSheets({
      carrier,
      regime: "ACI",
      tripNumbers: ["TRIP-2001", "TRIP-2002", "TRIP-2003"],
      driverName: "Dale Thompson",
      coDriverName: null,
      generatedAt: "2026-09-08T12:10:00.000Z",
    });
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1024);
    // Three pages: /Type /Page objects appear once per page (plus the /Pages root).
    expect((buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(3);
  });

  it("table report renders a landscape table", async () => {
    const buf = await renderTableReport({
      title: "Crossings",
      subtitle: "2026-09-01 to 2026-09-08",
      carrier,
      columns: [
        { key: "movementNumber", label: "Movement", width: 20 },
        { key: "port", label: "Port" },
        { key: "status", label: "Status" },
      ],
      rows: [
        { movementNumber: "ACE-26-00001", port: "3801 Detroit", status: "released" },
        { movementNumber: "ACI-26-00002", port: "0453 Windsor", status: "accepted" },
      ],
      generatedAt: "2026-09-08T12:10:00.000Z",
    });
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1024);
  });
});
