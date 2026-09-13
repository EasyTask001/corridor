import { describe, expect, it } from "vitest";

import { mapAvaalSnapshot } from "./mapping";
import { validateSnapshot, type AvaalUiRecord } from "./snapshot";

const category = (records: AvaalUiRecord[]) => ({
  route: "/visible/table",
  displayedTotal: records.length,
  finalPageReached: true,
  pagesVisited: [1],
  records,
  warnings: [],
});

const location = (
  sourceId: string,
  name: string,
  address: string,
  city = "Winnipeg",
): AvaalUiRecord => ({
  sourceId,
  sourceUrl: `/visible/table#${sourceId}`,
  fields: {
    Name: name,
    Address: address,
    City: city,
    "Province/State": "MB",
    Country: "Canada",
    "Postal/Zip Code": "R3C 0V8",
  },
});

describe("Avaal snapshot mapping", () => {
  it("merges a matching shipper and consignee into one both partner", () => {
    const snapshot = validateSnapshot({
      source: "avaal-ui",
      username: "pftrans",
      extractedAt: "2026-09-09T22:00:00.000Z",
      categories: {
        shippers: category([
          location("shipper-1", "ACME INC.", "100 Main Street"),
          location("shipper-2", "OTHER CO", "200 Main Street"),
        ]),
        consignees: category([
          location("consignee-1", "Acme Inc", "100 MAIN STREET"),
          location("consignee-2", "ACME INC.", "300 Main Street"),
        ]),
      },
    });

    const bundle = mapAvaalSnapshot(snapshot);

    expect(bundle.partners).toHaveLength(3);
    expect(bundle.partners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "both",
          sourceKeys: ["shipper-1", "consignee-1"],
          name: "ACME INC.",
        }),
        expect.objectContaining({ type: "shipper", sourceKeys: ["shipper-2"] }),
        expect.objectContaining({ type: "consignee", sourceKeys: ["consignee-2"] }),
      ]),
    );
  });

  it("maps company carrier identities without inventing other identifiers", () => {
    const snapshot = validateSnapshot({
      source: "avaal-ui",
      username: "pftrans",
      extractedAt: "2026-09-09T22:00:00.000Z",
      categories: {
        company: category([
          {
            sourceId: "company",
            sourceUrl: "/Masters/Company/Company",
            fields: {
              "Company Name": "PATHFINDER TRANS INC.",
              "SCAC Code": "PFTS",
              "Canadian Carrier Code": "7ELU",
              "Filer Code": "S9F",
              Country: "Canada",
              "Province/State": "Manitoba",
              "Use Simple Driver Sheet": true,
            },
          },
        ]),
      },
    });

    const bundle = mapAvaalSnapshot(snapshot);
    const organization = bundle.organization;
    expect(organization).not.toBeNull();
    if (!organization) throw new Error("organization missing");

    expect(organization).toMatchObject({
      name: "PATHFINDER TRANS INC.",
      scacCode: "PFTS",
      canadianCarrierCode: "7ELU",
      filerCode: "S9F",
      simpleDriverSheet: true,
    });
    expect(organization.usDotNumber).toBeNull();
    expect(bundle.carrierCodes).toEqual([
      { sourceKey: "carrier:ACE:PFTS", regime: "ACE", code: "PFTS", isDefault: true },
      { sourceKey: "carrier:ACI:7ELU", regime: "ACI", code: "7ELU", isDefault: true },
    ]);
  });
});
