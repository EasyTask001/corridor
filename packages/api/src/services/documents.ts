/**
 * Document intelligence service: storage paths, the `document.extract` job,
 * and the human-confirmed "apply to movement" step. AI output is never
 * written to `cargo` without a reviewer submitting the (re-validated) lines.
 */
import { createClient } from "@supabase/supabase-js";
import { TRPCError } from "@trpc/server";
import { and, eq, schema, sql, type RlsTransaction } from "@corridor/db";
import { LOW_CONFIDENCE_THRESHOLD, isEditable, type ApplyExtractionInput } from "@corridor/domain";
import { runExtractionPipeline } from "@corridor/ai";
import { addEvent, requireMovement, type Actor } from "./movements";
import { notifyOrganization } from "./notifications";

const { sourceDocuments, cargo, complianceAlerts } = schema;

export const DOCUMENTS_BUCKET = "documents";

export function storagePathFor(orgId: string, documentId: string, filename: string) {
  const safe = filename.replace(/[^\w.-]+/g, "_").slice(0, 120);
  return `${orgId}/${documentId}/${safe}`;
}

/** Service-role storage client for workers (no user session). */
function adminStorage() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required for extraction");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    .storage;
}

/**
 * Job handler: download → pipeline → persist result (or failure) → raise a
 * compliance alert when confidence is low. Runs under the service role.
 */
export async function extractDocumentJob(tx: RlsTransaction, orgId: string, documentId: string) {
  const [doc] = await tx
    .select()
    .from(sourceDocuments)
    .where(and(eq(sourceDocuments.id, documentId), eq(sourceDocuments.organizationId, orgId)))
    .limit(1);
  if (!doc) throw new Error(`source document ${documentId} not found`);
  if (doc.uploadStatus === "applied") return { skipped: true, reason: "already applied" };

  await tx
    .update(sourceDocuments)
    .set({ uploadStatus: "processing", extractionStartedAt: new Date(), extractionError: null })
    .where(eq(sourceDocuments.id, doc.id));

  const { data: blob, error } = await adminStorage()
    .from(DOCUMENTS_BUCKET)
    .download(doc.storagePath);
  if (error || !blob) {
    const msg = `download failed: ${error?.message ?? "no data"}`;
    await tx
      .update(sourceDocuments)
      .set({ uploadStatus: "failed", extractionError: msg, extractionCompletedAt: new Date() })
      .where(eq(sourceDocuments.id, doc.id));
    throw new Error(msg);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const outcome = await runExtractionPipeline({
    bytes,
    mimeType: doc.mimeType,
    filename: doc.originalFilename,
    declaredType: doc.documentType,
  });

  if (!outcome.ok) {
    await tx
      .update(sourceDocuments)
      .set({
        uploadStatus: "failed",
        extractionModel: outcome.model,
        extractionError: [outcome.error, ...(outcome.issues ?? [])].join(" | ").slice(0, 2000),
        extractionCompletedAt: new Date(),
      })
      .where(eq(sourceDocuments.id, doc.id));
    // Not thrown: a validation failure is a terminal, reviewable outcome, not a retryable error.
    return { ok: false, error: outcome.error };
  }

  await tx
    .update(sourceDocuments)
    .set({
      uploadStatus: "extracted",
      detectedType: outcome.detectedType,
      extractedJson: outcome.document,
      extractionModel: outcome.model,
      extractionConfidence: outcome.confidence,
      extractionCompletedAt: new Date(),
    })
    .where(eq(sourceDocuments.id, doc.id));

  if (outcome.confidence < LOW_CONFIDENCE_THRESHOLD || outcome.lowConfidenceFields.length > 0) {
    const dedupeKey = `document:${doc.id}:low_confidence`;
    await tx
      .insert(complianceAlerts)
      .values({
        organizationId: orgId,
        movementId: doc.movementId,
        alertType: "missing_data",
        severity: outcome.confidence < 0.4 ? "warning" : "info",
        source: "ai",
        title: `Review needed: ${doc.originalFilename} extracted with ${Math.round(outcome.confidence * 100)}% confidence`,
        description: `Fields needing attention: ${outcome.lowConfidenceFields.join(", ") || "overall confidence"}. Confirm or correct before applying to a manifest.`,
        dedupeKey,
        metadata: {
          documentId: doc.id,
          lowConfidenceFields: outcome.lowConfidenceFields,
          model: outcome.model,
        },
      })
      .onConflictDoNothing();
    await notifyOrganization(tx, {
      orgId,
      eventType: "document.review_needed",
      title: `Review needed: ${doc.originalFilename}`,
      body: `Extracted with ${Math.round(outcome.confidence * 100)}% confidence. Fields needing attention: ${outcome.lowConfidenceFields.join(", ") || "overall confidence"}.`,
      linkPath: `/documents/${doc.id}`,
    });
  }

  if (doc.movementId) {
    await addEvent(tx, { orgId, userId: null }, doc.movementId, {
      eventType: "ai_flag",
      actorType: "ai",
      payload: {
        title: `Extracted ${outcome.document.cargo.length} line(s) from ${doc.originalFilename}`,
        documentId: doc.id,
        confidence: outcome.confidence,
        lowConfidenceFields: outcome.lowConfidenceFields,
        model: outcome.model,
      },
    });
  }

  return {
    ok: true,
    confidence: outcome.confidence,
    lines: outcome.document.cargo.length,
    model: outcome.model,
  };
}

/** Reviewer applies confirmed lines to a draft/rejected movement. */
export async function applyExtraction(
  tx: RlsTransaction,
  actor: Actor,
  input: ApplyExtractionInput,
) {
  const [doc] = await tx
    .select()
    .from(sourceDocuments)
    .where(
      and(
        eq(sourceDocuments.id, input.documentId),
        eq(sourceDocuments.organizationId, actor.orgId),
      ),
    )
    .limit(1);
  if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
  if (doc.uploadStatus !== "extracted" && doc.uploadStatus !== "applied") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Document has not been extracted yet",
    });
  }
  const m = await requireMovement(tx, actor.orgId, input.movementId);
  if (!isEditable(m.status)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Movement cannot be edited while ${m.status}`,
    });
  }

  if (input.mode === "replace") {
    await tx.delete(cargo).where(eq(cargo.movementId, m.id));
  }
  const startRows = await tx
    .select({ next: sql<number>`coalesce(max(${cargo.lineNumber}), 0) + 1` })
    .from(cargo)
    .where(eq(cargo.movementId, m.id));
  let line = startRows[0]?.next ?? 1;

  const inserted = await tx
    .insert(cargo)
    .values(
      input.lines.map((l) => ({
        movementId: m.id,
        organizationId: actor.orgId,
        lineNumber: line++,
        shipperId: input.shipperId ?? null,
        consigneeId: input.consigneeId ?? null,
        commodityDescription: l.commodityDescription,
        hsCode: l.hsCode ?? null,
        weightKg: l.weightKg ?? null,
        pieceCount: l.pieceCount ?? null,
        packagingType: l.packagingType ?? null,
        entryNumber: l.entryNumber ?? null,
        inBondNumber: l.inBondNumber ?? null,
        valueAmount: l.valueAmount ?? null,
        valueCurrency: l.valueCurrency ?? null,
        countryOfOrigin: l.countryOfOrigin ?? null,
        sourceDocumentId: doc.id,
        extractionConfidence: l.extractionConfidence ?? null,
      })),
    )
    .returning({ id: cargo.id });

  await tx
    .update(sourceDocuments)
    .set({
      uploadStatus: "applied",
      movementId: doc.movementId ?? m.id,
      appliedMovementId: m.id,
      reviewedBy: actor.userId,
      reviewedAt: new Date(),
    })
    .where(eq(sourceDocuments.id, doc.id));

  await addEvent(tx, actor, m.id, {
    eventType: "note",
    actorType: "user",
    payload: {
      body: `Applied ${inserted.length} shipment line(s) from ${doc.originalFilename} (reviewed AI extraction, ${input.mode}).`,
      documentId: doc.id,
    },
  });

  // Reviewer confirmed the data → resolve the AI low-confidence alert.
  await tx
    .update(complianceAlerts)
    .set({ status: "resolved", resolvedBy: actor.userId, resolvedAt: new Date() })
    .where(
      and(
        eq(complianceAlerts.organizationId, actor.orgId),
        eq(complianceAlerts.dedupeKey, `document:${doc.id}:low_confidence`),
        sql`${complianceAlerts.status} in ('open','acknowledged')`,
      ),
    );

  return { movementId: m.id, inserted: inserted.length };
}
