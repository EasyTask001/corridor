import { describe, expect, it } from "vitest";
import { cargoInput } from "./movement";
import { extractedDocument, extractedLineToCargo, type ExtractedDocument } from "./document";

const good: ExtractedDocument = {
  documentType: "bol",
  documentNumber: "BOL-1001",
  documentDate: "2026-09-01",
  shipper: {
    name: "Maple Ridge Steel Ltd",
    address: "Hamilton, ON",
    taxId: null,
    confidence: 0.95,
  },
  consignee: {
    name: "Great Lakes Fabrication Inc",
    address: "Dearborn, MI",
    taxId: null,
    confidence: 0.9,
  },
  broker: null,
  cargo: [
    {
      commodityDescription: "Hot-rolled steel coils",
      hsCode: "7208.10",
      weightKg: 21500,
      pieceCount: 12,
      packagingType: "coil",
      valueAmount: 48000,
      valueCurrency: "USD",
      countryOfOrigin: "CA",
      confidence: 0.92,
    },
  ],
  totals: { weightKg: 21500, pieceCount: 12, valueAmount: 48000, valueCurrency: "USD" },
  notes: [],
  confidence: 0.9,
};

describe("extractedDocument schema", () => {
  it("accepts a complete extraction", () => {
    expect(extractedDocument.safeParse(good).success).toBe(true);
  });

  it("rejects out-of-range confidence and malformed HS codes (AI output cannot bypass validation)", () => {
    expect(extractedDocument.safeParse({ ...good, confidence: 1.5 }).success).toBe(false);
    expect(
      extractedDocument.safeParse({ ...good, cargo: [{ ...good.cargo[0]!, hsCode: "72" }] })
        .success,
    ).toBe(false);
    expect(
      extractedDocument.safeParse({ ...good, cargo: [{ ...good.cargo[0]!, weightKg: -5 }] })
        .success,
    ).toBe(false);
  });

  it("extracted lines map onto the cargo input schema unchanged", () => {
    const mapped = extractedLineToCargo(good.cargo[0]!);
    const parsed = cargoInput.safeParse(mapped);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.extractionConfidence).toBe(0.92);
  });
});
