import { z } from "zod";
import { uuid } from "./common";
import { regime } from "./movement";

/** Matches generated_documents.kind (migration 0024). */
export const generatedDocumentKind = z.enum([
  "driver_sheet",
  "blank_driver_sheet",
  "manifest_summary",
  "report",
  "registry_export",
]);
export type GeneratedDocumentKind = z.infer<typeof generatedDocumentKind>;

export const pdfGenerateInput = z.object({
  movementId: uuid,
  kind: z.enum(["driver_sheet", "manifest_summary"]),
});
export type PdfGenerateInput = z.infer<typeof pdfGenerateInput>;

/** Trip numbers are `<prefix><n>`; the range is inclusive and capped at 50 pages. */
export const blankDriverSheetsInput = z
  .object({
    regime,
    prefix: z.string().trim().max(20).default("TRIP-"),
    fromTrip: z.number().int().min(0).max(999_999_999),
    toTrip: z.number().int().min(0).max(999_999_999),
    driverName: z.string().trim().max(120).nullable().optional(),
    coDriverName: z.string().trim().max(120).nullable().optional(),
  })
  .refine((v) => v.toTrip >= v.fromTrip, {
    message: "toTrip must be at least fromTrip",
    path: ["toTrip"],
  })
  .refine((v) => v.toTrip - v.fromTrip < 50, {
    message: "At most 50 sheets per batch",
    path: ["toTrip"],
  });
export type BlankDriverSheetsInput = z.infer<typeof blankDriverSheetsInput>;

export const pdfDownloadInput = z.object({ id: uuid });

/** "Send by email": a rendered document to up to five addresses. */
export const pdfEmailInput = z.object({
  id: uuid,
  to: z.array(z.string().trim().toLowerCase().email()).min(1).max(5),
  message: z.string().trim().max(1000).optional(),
});
export type PdfEmailInput = z.infer<typeof pdfEmailInput>;
