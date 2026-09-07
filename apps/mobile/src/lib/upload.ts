/**
 * Three-step document upload, identical to the web flow: reserve the row and
 * mint a signed URL (`documents.getUploadUrl`), PUT the bytes straight to
 * Supabase Storage, then finalize so extraction is queued.
 *
 * Only the finalize step goes through the outbox. The first two need a live
 * connection by nature — there is no signed URL to write to while offline —
 * so a capture attempted with no signal fails fast and asks the driver to
 * retry, rather than pretending it was stored.
 */
import { getUploadUrlInput, type DocumentType } from "@corridor/domain";
import { outbox } from "./outbox-client";
import { trpc } from "./trpc";

export interface UploadDocumentInput {
  /** `file://` (camera roll) or `data:` (generated PNG) URI. */
  uri: string;
  filename: string;
  mimeType: string;
  documentType: DocumentType;
  movementId: string;
}

export interface UploadDocumentResult {
  documentId: string;
  /** False when finalize was queued for replay rather than sent. */
  finalized: boolean;
}

export async function uploadDocument(input: UploadDocumentInput): Promise<UploadDocumentResult> {
  // React Native's fetch resolves file:// and data: URIs to a Blob, which is
  // also what gives us the byte count the API validates against.
  const blob = await (await fetch(input.uri)).blob();

  const reservation = getUploadUrlInput.parse({
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: blob.size,
    documentType: input.documentType,
    movementId: input.movementId,
  });
  const { documentId, signedUrl } = await trpc.documents.getUploadUrl.mutate(reservation);

  const put = await fetch(signedUrl, {
    method: "PUT",
    headers: { "content-type": input.mimeType, "x-upsert": "true" },
    body: blob,
  });
  if (!put.ok) {
    throw new Error(`Upload failed (${put.status}). The document was not stored.`);
  }

  const result = await outbox.submit("documents.finalizeUpload", { documentId });
  return { documentId, finalized: result.sent > 0 };
}
