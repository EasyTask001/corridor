import type { DocumentType } from "@corridor/domain";

/**
 * Cheap, deterministic first-pass classification from filename + declared
 * type. The extractor refines it (`documentType` is part of its output), and
 * the pipeline reconciles the two.
 */
export function classifyByHints(filename: string, declared: DocumentType): DocumentType {
  if (declared !== "other") return declared;
  // "_" and "-" are word characters, so use explicit non-letter boundaries.
  const f = ` ${filename.toLowerCase().replace(/[-_.]+/g, " ")} `;
  if (/ (bol|bill of lading|lading) /.test(f)) return "bol";
  if (/ (inv|invoice|commercial) /.test(f)) return "invoice";
  if (/ (rate con|rate confirmation|ratecon) /.test(f)) return "rate_confirmation";
  return "other";
}
