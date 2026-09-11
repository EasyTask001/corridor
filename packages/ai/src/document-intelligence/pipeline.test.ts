import { describe, expect, it } from "vitest";
import { classifyByHints } from "./classify";
import { mockExtractor } from "./mock-extractor";
import { lowConfidenceFields, runExtractionPipeline, selectExtractor } from "./pipeline";
import type { Extractor } from "./types";

const enc = new TextEncoder();
const textDoc = (s: string, filename = "doc.txt") => ({
  bytes: enc.encode(s),
  mimeType: "text/plain",
  filename,
  declaredType: "other" as const,
});

describe("classifyByHints", () => {
  it("uses the declared type first, then filename cues", () => {
    expect(classifyByHints("anything.pdf", "invoice")).toBe("invoice");
    expect(classifyByHints("scan_bill-of-lading_1.pdf", "other")).toBe("bol");
    expect(classifyByHints("ratecon-4471.pdf", "other")).toBe("rate_confirmation");
    expect(classifyByHints("IMG_2231.jpg", "other")).toBe("other");
  });

  it("detects rate confirmations from content when the filename says nothing", () => {
    expect(classifyByHints("IMG_2231.jpg", "other", "CARRIER RATE CONFIRMATION\nLoad 4471")).toBe(
      "rate_confirmation",
    );
    expect(classifyByHints("scan.pdf", "other", "Rate Con  #4471")).toBe("rate_confirmation");
    expect(classifyByHints("scan.pdf", "other", "LOAD TENDER — please sign")).toBe(
      "rate_confirmation",
    );
  });

  it("lets content override a misleading filename, but never the declared type", () => {
    const tender = "CARRIER RATE CONFIRMATION\nBill of lading to follow";
    expect(classifyByHints("bol-4471.pdf", "other", tender)).toBe("rate_confirmation");
    expect(classifyByHints("bol-4471.pdf", "bol", tender)).toBe("bol");
  });
});

describe("selectExtractor", () => {
  it("forces the mock for .mock. filenames and when no key is present", () => {
    const noKey = { CORRIDOR_EXTRACTOR: undefined, OPENAI_API_KEY: undefined } as NodeJS.ProcessEnv;
    expect(
      selectExtractor(textDoc("x", "bol.mock.pdf"), {
        env: { OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv,
      }).name,
    ).toBe("mock");
    expect(selectExtractor(textDoc("x", "bol.pdf"), { env: noKey }).name).toBe("mock");
    expect(
      selectExtractor(textDoc("x", "bol.pdf"), {
        env: { OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv,
      }).name,
    ).toMatch(/^openai:/);
    expect(
      selectExtractor(textDoc("x", "bol.pdf"), {
        env: { OPENAI_API_KEY: "k", CORRIDOR_EXTRACTOR: "mock" } as NodeJS.ProcessEnv,
      }).name,
    ).toBe("mock");
  });
});

describe("runExtractionPipeline", () => {
  it("validates output and derives overall confidence from the parts", async () => {
    const out = await runExtractionPipeline(
      textDoc(
        `BOL: B1\nShipper: A Co, Town\nConsignee: B Inc, City\nLine: Widgets | 8471.30 | 100 kg | 2 pcs | 500 USD | CA`,
      ),
      { extractor: mockExtractor },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detectedType).toBe("bol");
    expect(out.document.cargo[0]).toMatchObject({
      hsCode: "8471.30",
      weightKg: 100,
      pieceCount: 2,
    });
    expect(out.lowConfidenceFields).toEqual([]);
    expect(out.confidence).toBeLessThanOrEqual(out.document.shipper.confidence);
  });

  it("flags low-confidence / missing required fields for human review", async () => {
    const out = await runExtractionPipeline(
      textDoc(`BOL: B2\nShipper: A Co\nLine: Mystery goods | | | |`),
      {
        extractor: mockExtractor,
      },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.lowConfidenceFields).toEqual(
      expect.arrayContaining(["consignee", "cargo[0]", "cargo[0].weightKg", "cargo[0].pieceCount"]),
    );
    expect(out.confidence).toBeLessThan(0.7);
  });

  it("rejects structurally invalid extractor output instead of trusting it", async () => {
    const bad: Extractor = {
      name: "bad",
      extract: async () => ({
        raw: {
          documentType: "bol",
          cargo: [{ commodityDescription: "x", hsCode: "12", confidence: 2 }],
        },
        model: "bad",
      }),
    };
    const out = await runExtractionPipeline(textDoc("irrelevant"), { extractor: bad });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/failed domain validation/);
    expect(out.issues?.some((i) => i.includes("confidence"))).toBe(true);
  });

  it("turns extractor exceptions into a failure outcome", async () => {
    const boom: Extractor = {
      name: "boom",
      extract: async () => {
        throw new Error("provider down");
      },
    };
    const out = await runExtractionPipeline(textDoc("x"), { extractor: boom });
    expect(out).toMatchObject({ ok: false, error: "provider down" });
  });

  it("treats a rate confirmation as a load tender: no cargo, tender confidence", async () => {
    const out = await runExtractionPipeline(
      textDoc(
        `CARRIER RATE CONFIRMATION\nRate Confirmation: RC-900\nBroker: Great Lakes Logistics LLC, Detroit MI\nCarrier: Pathfinder Trans Inc, Windsor ON\nShipper: Erie Produce Co, Buffalo NY\nConsignee: Fort Erie Cold Storage, Fort Erie ON\nPickup: 2026-09-05T08:00\nDelivery: 2026-09-06T14:00\nEquipment: 53' reefer\nRate: 2,450.00 USD`,
        "scan-4471.txt",
      ),
      { extractor: mockExtractor },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detectedType).toBe("rate_confirmation");
    // No commodity detail on a tender — nothing may become a cargo line.
    expect(out.document.cargo).toEqual([]);
    expect(out.document.rateConfirmation).toMatchObject({
      carrierName: "Pathfinder Trans Inc",
      brokerName: "Great Lakes Logistics LLC",
      referenceNumber: "RC-900",
      rateAmount: 2450,
      rateCurrency: "USD",
      pickupAt: "2026-09-05T08:00",
      deliveryAt: "2026-09-06T14:00",
      equipment: "53' reefer",
    });
    // Missing cargo is not a review flag on a tender; its own block carries the score.
    expect(out.lowConfidenceFields).toEqual([]);
    expect(out.confidence).toBe(out.document.rateConfirmation!.confidence);
  });

  it("flags an unreadable rate confirmation rather than reporting empty cargo", async () => {
    const out = await runExtractionPipeline(
      textDoc(`RATE CONFIRMATION\nShipper: Erie Produce Co`, "tender.txt"),
      { extractor: mockExtractor },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.lowConfidenceFields).toEqual(["rateConfirmation"]);
    expect(out.confidence).toBeLessThan(0.7);
  });

  it("non-tender documents carry no rate-confirmation block", async () => {
    const out = await runExtractionPipeline(
      textDoc(`BOL: B3\nShipper: A Co\nConsignee: B Inc\nLine: Widgets | 8471.30 | 10 kg | 1 pcs`),
      { extractor: mockExtractor },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.document.rateConfirmation).toBeNull();
  });

  it("rounds AI-extracted money fields to cents before validation", async () => {
    const raw = {
      documentType: "bol",
      documentNumber: null,
      documentDate: null,
      shipper: { name: "A Co", address: null, taxId: null, confidence: 0.9 },
      consignee: { name: "B Inc", address: null, taxId: null, confidence: 0.9 },
      broker: null,
      cargo: [
        {
          commodityDescription: "Widgets",
          hsCode: null,
          weightKg: 100,
          pieceCount: 2,
          packagingType: null,
          valueAmount: 12.345,
          valueCurrency: "USD",
          countryOfOrigin: null,
          confidence: 0.9,
        },
      ],
      rateConfirmation: null,
      totals: { weightKg: 100, pieceCount: 2, valueAmount: 12.345, valueCurrency: "USD" },
      notes: [],
      confidence: 0.9,
    };
    const stub: Extractor = {
      name: "stub",
      extract: async () => ({ raw, model: "stub" }),
    };
    const out = await runExtractionPipeline(textDoc("irrelevant"), { extractor: stub });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.document.cargo[0]?.valueAmount).toBe(12.35);
    expect(out.document.totals?.valueAmount).toBe(12.35);
  });

  it("lowConfidenceFields handles empty cargo", () => {
    expect(
      lowConfidenceFields({ shipper: { confidence: 1 }, consignee: { confidence: 1 }, cargo: [] }),
    ).toEqual(["cargo"]);
  });
});
