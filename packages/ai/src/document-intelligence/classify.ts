import type { DocumentType } from "@corridor/domain";

/** Content cues, checked in order. Rate confirmations first: a load tender often
 * quotes "BILL TO" / shipper blocks that would otherwise read as a BOL. */
const CONTENT_CUES: Array<[DocumentType, RegExp]> = [
  ["rate_confirmation", /\b(rate\s+con(firmation)?|carrier\s+rate|load\s+tender)\b/i],
  ["bol", /\b(bill\s+of\s+lading|straight\s+bill|b\/?o\/?l\b)/i],
  ["invoice", /\b(commercial\s+invoice|invoice\s*(no|number|#))\b/i],
];

/** Filename-only cues ("_" and "-" are word characters, so use explicit non-letter boundaries). */
function classifyByFilename(filename: string): DocumentType {
  const f = ` ${filename.toLowerCase().replace(/[-_.]+/g, " ")} `;
  if (/ (bol|bill of lading|lading) /.test(f)) return "bol";
  if (/ (inv|invoice|commercial) /.test(f)) return "invoice";
  if (/ (rate con|rate confirmation|ratecon|carrier rate) /.test(f)) return "rate_confirmation";
  return "other";
}

/** Content-based classification for documents we can read as text. */
export function classifyByContent(text: string): DocumentType {
  const head = text.slice(0, 4000);
  for (const [type, re] of CONTENT_CUES) if (re.test(head)) return type;
  return "other";
}

/**
 * Cheap, deterministic first-pass classification from the declared type,
 * document text (when readable) and filename. The extractor refines it
 * (`documentType` is part of its output) and the pipeline reconciles the two.
 *
 * Content wins over the filename: "ACME-4471.pdf" holding a rate confirmation
 * is a rate confirmation, and a load tender must not be mistaken for a BOL.
 */
export function classifyByHints(
  filename: string,
  declared: DocumentType,
  content?: string,
): DocumentType {
  if (declared !== "other") return declared;
  const byContent = content ? classifyByContent(content) : "other";
  if (byContent !== "other") return byContent;
  return classifyByFilename(filename);
}
