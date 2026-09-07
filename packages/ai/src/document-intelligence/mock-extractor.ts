/**
 * Mock extractor — deterministic, no network. Used when no model key is
 * configured, in tests, and for any file whose name contains ".mock."
 * (a dev hook, like the customs trip-number hooks).
 *
 * Understands two input shapes:
 *  1. JSON matching `extractedDocument` (fixtures) — echoed through.
 *  2. Plain-text "paper" documents with simple labelled lines:
 *       Shipper: Maple Ridge Steel Ltd, 400 Industrial Pkwy, Hamilton ON
 *       Consignee: Great Lakes Fabrication Inc, Dearborn MI
 *       BOL: BOL-1001   Date: 2026-09-01
 *       Line: Hot-rolled steel coils | 7208.10 | 21500 kg | 12 pcs | 48000 USD | CA
 *     Unlabelled / malformed values come back with low confidence so the
 *     human-in-the-loop path is exercised.
 * Anything else yields a single low-confidence placeholder line.
 */
import type { DocumentType, ExtractedDocument } from "@corridor/domain";
import type { DocumentInput, Extractor, ExtractorResult } from "./types";

const decoder = new TextDecoder();

function parseLine(text: string): ExtractedDocument["cargo"][number] {
  const parts = text.split("|").map((p) => p.trim());
  const [desc, hs, weight, pieces, value, origin] = parts;
  const num = (s: string | undefined, re: RegExp) => {
    const m = s?.match(re);
    return m ? Number(m[1]!.replace(/,/g, "")) : null;
  };
  const weightKg = num(weight, /([\d,.]+)\s*kg/i);
  const pieceCount = num(pieces, /(\d+)\s*(pcs|pieces|units|pallets|coils)?/i);
  const valueAmount = num(value, /([\d,.]+)\s*(USD|CAD)?/i);
  const currency = value?.match(/\b(USD|CAD)\b/i)?.[1]?.toUpperCase() as "USD" | "CAD" | undefined;
  const hsCode = hs && /^\d{4}(\.\d{2}(\.\d{2}(\.\d{2})?)?)?$/.test(hs) ? hs : null;
  const known = [desc, hsCode, weightKg, pieceCount, valueAmount, currency, origin].filter(
    (x) => x != null && x !== "",
  ).length;
  return {
    commodityDescription: desc || "Unreadable line",
    hsCode,
    weightKg,
    pieceCount,
    packagingType: null,
    valueAmount,
    valueCurrency: currency ?? null,
    countryOfOrigin: origin && /^[A-Za-z]{2}$/.test(origin) ? origin.toUpperCase() : null,
    confidence: Math.min(0.98, 0.3 + known * 0.1),
  };
}

function parseParty(line: string | undefined, conf: number) {
  if (!line) return { name: null, address: null, taxId: null, confidence: 0.2 };
  const [name, ...rest] = line.split(",").map((s) => s.trim());
  return { name: name || null, address: rest.join(", ") || null, taxId: null, confidence: conf };
}

export function mockExtract(input: DocumentInput, hint: { documentType: DocumentType }): unknown {
  const text = decoder.decode(input.bytes);

  // 1. JSON fixture
  if (input.mimeType === "application/json" || text.trim().startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch {
      /* fall through */
    }
  }

  // 2. Labelled plain text
  const grab = (label: string) =>
    text.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im"))?.[1]?.trim();
  const lines = [...text.matchAll(/^\s*Line\s*:\s*(.+)$/gim)].map((m) => parseLine(m[1]!));
  const isText = input.mimeType.startsWith("text/") && (lines.length > 0 || grab("Shipper"));

  if (isText) {
    const type: DocumentType = grab("Invoice")
      ? "invoice"
      : grab("Rate Confirmation") || grab("RateCon")
        ? "rate_confirmation"
        : grab("BOL") || grab("Bill of Lading")
          ? "bol"
          : hint.documentType;
    const shipper = parseParty(grab("Shipper"), 0.93);
    const consignee = parseParty(grab("Consignee"), 0.91);
    const brokerLine = grab("Broker");
    const cargo = lines.length ? lines : [parseLine("Unreadable line")];
    const notes: string[] = [];
    if (!shipper.name) notes.push("Shipper not found on document.");
    if (!consignee.name) notes.push("Consignee not found on document.");
    for (const [i, l] of cargo.entries()) {
      if (!l.hsCode) notes.push(`Line ${i + 1}: HS code missing or unreadable.`);
      if (!l.weightKg) notes.push(`Line ${i + 1}: weight missing.`);
    }
    const totalsWeight = cargo.reduce((s, l) => s + (l.weightKg ?? 0), 0) || null;
    const totalsPieces = cargo.reduce((s, l) => s + (l.pieceCount ?? 0), 0) || null;
    const totalsValue = cargo.reduce((s, l) => s + (l.valueAmount ?? 0), 0) || null;
    const overall = Math.min(
      shipper.confidence,
      consignee.confidence,
      ...cargo.map((c) => c.confidence),
    );
    return {
      documentType: type,
      documentNumber:
        grab("BOL") ?? grab("Invoice") ?? grab("Rate Confirmation") ?? grab("Number") ?? null,
      documentDate: grab("Date")?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
      shipper,
      consignee,
      broker: brokerLine ? parseParty(brokerLine, 0.85) : null,
      cargo,
      totals: {
        weightKg: totalsWeight,
        pieceCount: totalsPieces,
        valueAmount: totalsValue,
        valueCurrency: cargo.find((c) => c.valueCurrency)?.valueCurrency ?? null,
      },
      notes,
      confidence: overall,
    } satisfies ExtractedDocument;
  }

  // 3. Unknown binary (PDF/image without a model): placeholder for review
  return {
    documentType: hint.documentType,
    documentNumber: null,
    documentDate: null,
    shipper: { name: null, address: null, taxId: null, confidence: 0.1 },
    consignee: { name: null, address: null, taxId: null, confidence: 0.1 },
    broker: null,
    cargo: [
      {
        commodityDescription: `Contents of ${input.filename} (mock extractor cannot read ${input.mimeType})`,
        hsCode: null,
        weightKg: null,
        pieceCount: null,
        packagingType: null,
        valueAmount: null,
        valueCurrency: null,
        countryOfOrigin: null,
        confidence: 0.1,
      },
    ],
    totals: null,
    notes: ["Mock extractor: configure OPENAI_API_KEY to read PDFs and images."],
    confidence: 0.1,
  } satisfies ExtractedDocument;
}

export const mockExtractor: Extractor = {
  name: "mock",
  async extract(input, hint): Promise<ExtractorResult> {
    return { raw: mockExtract(input, hint), model: "mock" };
  },
};
