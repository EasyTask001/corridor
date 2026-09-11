/**
 * Shared "can we read this as text, and how much of it" logic for the
 * classifier (cheap filename/body hints) and the model extractor (the actual
 * document handed to `generateObject`). Both cap the bytes they decode —
 * unbounded text is a token-cost and prompt-size risk, not just a slowness one.
 */

/** text/* and application/json documents can be decoded and read directly. */
export function isTextDocument(mimeType: string): boolean {
  return mimeType.startsWith("text/") || mimeType === "application/json";
}

/** Bytes the classifier reads for filename/body hints (cheap, coarse). */
export const CLASSIFIER_TEXT_BYTES = 8192;

/** Bytes the extractor hands the model as document text (bounds token cost). */
export const EXTRACTION_TEXT_BYTES = 120_000;

/**
 * Decoded, byte-capped text for a document, or `undefined` when the document
 * isn't text (binary uploads — PDF/image — go through the model as a file
 * part instead).
 */
export function readableText(
  input: { mimeType: string; bytes: Uint8Array },
  maxBytes: number,
): string | undefined {
  if (!isTextDocument(input.mimeType)) return undefined;
  return new TextDecoder().decode(input.bytes.slice(0, maxBytes));
}
