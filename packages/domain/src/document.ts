import { z } from "zod";
import { isoDate, isoDateTime, uuid } from "./common";
import { countryCode, currency, hsCode, moneyAmount } from "./movement";
import { commodityInput, controlReference } from "./shipment";

export const documentType = z.enum(["bol", "invoice", "rate_confirmation", "other"]);
export type DocumentType = z.infer<typeof documentType>;

export const uploadStatus = z.enum(["uploaded", "processing", "extracted", "failed", "applied"]);
export type UploadStatus = z.infer<typeof uploadStatus>;

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
  "text/plain",
  "application/json",
] as const;
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** 0..1 confidence attached to every extracted field. */
export const confidence = z.number().min(0).max(1);

/** A party (shipper / consignee / broker) as it appears on paper. */
export const extractedParty = z.object({
  name: z.string().trim().max(160).nullable(),
  address: z.string().trim().max(300).nullable(),
  taxId: z.string().trim().max(40).nullable(),
  confidence,
});
export type ExtractedParty = z.infer<typeof extractedParty>;

/**
 * One commodity line as extracted. Field names mirror `commodityInput` so review →
 * apply is a straight mapping; `confidence` is per-line.
 */
export const extractedCargoLine = z.object({
  commodityDescription: z.string().trim().max(500),
  hsCode: hsCode.nullable(),
  weightKg: z.number().positive().max(100_000).nullable(),
  pieceCount: z.number().int().positive().nullable(),
  packagingType: z.string().trim().max(60).nullable(),
  valueAmount: moneyAmount.nullable(),
  valueCurrency: currency.nullable(),
  countryOfOrigin: countryCode.nullable(),
  confidence,
});
export type ExtractedCargoLine = z.infer<typeof extractedCargoLine>;

/**
 * ISO-8601 date-time as printed on a load tender. The offset is optional
 * because tenders quote local pickup/delivery windows without one.
 */
const tenderDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
    "Expected an ISO-8601 date-time",
  );

/**
 * A broker → carrier rate confirmation (load tender). It is NOT a customs
 * document: it carries no commodity detail, so nothing here ever becomes a
 * commodity line or a manifest field — review shows it read-only. Non-rate-con
 * documents carry `null` here.
 */
export const extractedRateConfirmation = z.object({
  carrierName: z.string().trim().max(160).nullable(),
  brokerName: z.string().trim().max(160).nullable(),
  referenceNumber: z.string().trim().max(60).nullable(),
  rateAmount: z.number().nonnegative().max(1_000_000).nullable(),
  rateCurrency: currency.nullable(),
  pickupAt: tenderDateTime.nullable(),
  deliveryAt: tenderDateTime.nullable(),
  equipment: z.string().trim().max(80).nullable(),
  confidence,
});
export type ExtractedRateConfirmation = z.infer<typeof extractedRateConfirmation>;

/**
 * THE extraction contract. The same schema validates the model's structured
 * output (`generateObject`) and the review form, so AI output can never
 * bypass domain validation on its way into `commodities`.
 */
export const extractedDocument = z.object({
  documentType,
  documentNumber: z.string().trim().max(60).nullable(),
  documentDate: isoDate.nullable(),
  shipper: extractedParty,
  consignee: extractedParty,
  broker: extractedParty.nullable(),
  cargo: z.array(extractedCargoLine).max(50),
  /**
   * Load-tender details, present only when `documentType` is
   * "rate_confirmation" (null otherwise — nullable rather than optional so the
   * schema stays valid for providers that require every key).
   */
  rateConfirmation: extractedRateConfirmation.nullable(),
  totals: z
    .object({
      weightKg: z.number().nonnegative().nullable(),
      pieceCount: z.number().int().nonnegative().nullable(),
      valueAmount: moneyAmount.nullable(),
      valueCurrency: currency.nullable(),
    })
    .nullable(),
  /** Anything the extractor was unsure about, for the reviewer. */
  notes: z.array(z.string().max(300)).max(20),
  /**
   * overall confidence — min of the required-field confidences (see pipeline),
   * or the rate-confirmation block's confidence for a load tender
   */
  confidence,
});
export type ExtractedDocument = z.infer<typeof extractedDocument>;

/** Threshold below which a document (or line) raises a compliance alert for review. */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

export const sourceDocumentSchema = z.object({
  id: uuid,
  organizationId: uuid,
  movementId: uuid.nullable(),
  documentType,
  detectedType: documentType.nullable(),
  storagePath: z.string(),
  originalFilename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().nullable(),
  uploadStatus,
  extractedJson: extractedDocument.nullable(),
  extractionModel: z.string().nullable(),
  extractionConfidence: confidence.nullable(),
  extractionError: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

// ---------------------------------------------------------------------------
// API inputs
// ---------------------------------------------------------------------------

export const getUploadUrlInput = z.object({
  filename: z.string().trim().min(1).max(200),
  mimeType: z.enum(ALLOWED_DOCUMENT_MIME_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
  documentType: documentType.default("other"),
  movementId: uuid.optional(),
});
export type GetUploadUrlInput = z.infer<typeof getUploadUrlInput>;

export const finalizeUploadInput = z.object({ documentId: uuid });

export const documentListInput = z.object({
  status: z.array(uploadStatus).optional(),
  movementId: uuid.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

/**
 * Reviewer-confirmed lines. Applying them creates ONE draft shipment on the
 * chosen movement carrying every line, since a document is one bill of lading.
 */
export const applyExtractionInput = z.object({
  documentId: uuid,
  movementId: uuid,
  /** PAPS/PARS number for the shipment the lines land on. */
  controlReference,
  shipperId: uuid.nullable().optional(),
  consigneeId: uuid.nullable().optional(),
  brokerId: uuid.nullable().optional(),
  lines: z
    .array(commodityInput.omit({ sourceDocumentId: true, hazmat: true }))
    .min(1)
    .max(50),
});
export type ApplyExtractionInput = z.infer<typeof applyExtractionInput>;

/** Map an extracted line to a commodityInput-compatible object (confidence carried along). */
export function extractedLineToCommodity(line: ExtractedCargoLine) {
  return {
    commodityDescription: line.commodityDescription,
    hsCode: line.hsCode,
    weightKg: line.weightKg,
    quantity: line.pieceCount,
    packagingType: line.packagingType,
    valueAmount: line.valueAmount,
    valueCurrency: line.valueCurrency,
    countryOfOrigin: line.countryOfOrigin,
    extractionConfidence: line.confidence,
  };
}
