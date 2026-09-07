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

  it("lowConfidenceFields handles empty cargo", () => {
    expect(
      lowConfidenceFields({ shipper: { confidence: 1 }, consignee: { confidence: 1 }, cargo: [] }),
    ).toEqual(["cargo"]);
  });
});
