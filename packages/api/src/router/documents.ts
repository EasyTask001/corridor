import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, schema, sql } from "@corridor/db";
import {
  applyExtractionInput,
  documentListInput,
  finalizeUploadInput,
  getUploadUrlInput,
  uuid,
} from "@corridor/domain";
import { modelExtractorAvailable } from "@corridor/ai";
import { permissionProcedure, router } from "../trpc";
import { DOCUMENTS_BUCKET, applyExtraction, storagePathFor } from "../services/documents";
import { enqueueJob } from "../services/jobs";
import { requireMovement } from "../services/movements";
import { writeAudit } from "../services/audit";

const { sourceDocuments, movements, userProfiles } = schema;

export const documentsRouter = router({
  /** Which extractor will run — surfaced in the UI so reviewers know what produced the data. */
  capabilities: permissionProcedure("document.read").query(() => ({
    extractor:
      process.env.CORRIDOR_EXTRACTOR === "mock" || !modelExtractorAvailable() ? "mock" : "model",
    model: process.env.CORRIDOR_EXTRACTION_MODEL ?? "gpt-4.1-mini",
  })),

  /**
   * Step 1: reserve a source_documents row and hand back a signed upload URL.
   * The browser uploads straight to Storage — the file never passes through
   * a Next.js function.
   */
  getUploadUrl: permissionProcedure("document.upload")
    .input(getUploadUrlInput)
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.rls(async (tx) => {
        if (input.movementId) await requireMovement(tx, ctx.orgId, input.movementId);
        const id = crypto.randomUUID();
        const [r] = await tx
          .insert(sourceDocuments)
          .values({
            id,
            organizationId: ctx.orgId,
            movementId: input.movementId ?? null,
            documentType: input.documentType,
            storagePath: storagePathFor(ctx.orgId, id, input.filename),
            originalFilename: input.filename,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            uploadedBy: ctx.session.user.id,
          })
          .returning({ id: sourceDocuments.id, storagePath: sourceDocuments.storagePath });
        return r!;
      });
      // Signed URL is minted with the caller's session, so Storage RLS applies.
      const { data, error } = await ctx.supabase.storage
        .from(DOCUMENTS_BUCKET)
        .createSignedUploadUrl(row.storagePath);
      if (error || !data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Could not create upload URL: ${error?.message}`,
        });
      }
      return { documentId: row.id, path: data.path, token: data.token, signedUrl: data.signedUrl };
    }),

  /** Step 2: after the browser upload completes, queue extraction. */
  finalizeUpload: permissionProcedure("document.upload")
    .input(finalizeUploadInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const [doc] = await tx
          .select()
          .from(sourceDocuments)
          .where(
            and(
              eq(sourceDocuments.id, input.documentId),
              eq(sourceDocuments.organizationId, ctx.orgId),
            ),
          )
          .limit(1);
        if (!doc) throw new TRPCError({ code: "NOT_FOUND" });
        await enqueueJob(tx, {
          orgId: ctx.orgId,
          jobType: "document.extract",
          payload: { documentId: doc.id },
          maxAttempts: 2,
        });
        await writeAudit(tx, ctx.orgId, "document.upload", "source_document", doc.id, null, {
          filename: doc.originalFilename,
          documentType: doc.documentType,
          movementId: doc.movementId,
        });
        return { documentId: doc.id, status: doc.uploadStatus };
      }),
    ),

  retry: permissionProcedure("document.upload")
    .input(z.object({ documentId: uuid }))
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const [doc] = await tx
          .update(sourceDocuments)
          .set({ uploadStatus: "uploaded", extractionError: null })
          .where(
            and(
              eq(sourceDocuments.id, input.documentId),
              eq(sourceDocuments.organizationId, ctx.orgId),
              inArray(sourceDocuments.uploadStatus, ["failed", "extracted"]),
            ),
          )
          .returning({ id: sourceDocuments.id });
        if (!doc)
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Document cannot be re-extracted in its current state",
          });
        await enqueueJob(tx, {
          orgId: ctx.orgId,
          jobType: "document.extract",
          payload: { documentId: doc.id },
          maxAttempts: 2,
        });
        await writeAudit(tx, ctx.orgId, "document.retry", "source_document", doc.id);
        return doc;
      }),
    ),

  list: permissionProcedure("document.read")
    .input(documentListInput)
    .query(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const conds = [eq(sourceDocuments.organizationId, ctx.orgId)];
        if (input.status?.length) conds.push(inArray(sourceDocuments.uploadStatus, input.status));
        if (input.movementId) conds.push(eq(sourceDocuments.movementId, input.movementId));
        const where = and(...conds);
        const [rows, counts] = await Promise.all([
          tx
            .select({
              id: sourceDocuments.id,
              originalFilename: sourceDocuments.originalFilename,
              mimeType: sourceDocuments.mimeType,
              sizeBytes: sourceDocuments.sizeBytes,
              documentType: sourceDocuments.documentType,
              detectedType: sourceDocuments.detectedType,
              uploadStatus: sourceDocuments.uploadStatus,
              extractionConfidence: sourceDocuments.extractionConfidence,
              extractionModel: sourceDocuments.extractionModel,
              extractionError: sourceDocuments.extractionError,
              movementId: sourceDocuments.movementId,
              movementNumber: movements.movementNumber,
              lineCount: sql<number>`coalesce(jsonb_array_length(${sourceDocuments.extractedJson} -> 'cargo'), 0)`,
              uploadedByName: userProfiles.displayName,
              createdAt: sourceDocuments.createdAt,
              updatedAt: sourceDocuments.updatedAt,
            })
            .from(sourceDocuments)
            .leftJoin(movements, eq(movements.id, sourceDocuments.movementId))
            .leftJoin(userProfiles, eq(userProfiles.userId, sourceDocuments.uploadedBy))
            .where(where)
            .orderBy(desc(sourceDocuments.createdAt))
            .limit(input.limit)
            .offset(input.offset),
          tx
            .select({ count: sql<number>`count(*)::int` })
            .from(sourceDocuments)
            .where(where),
        ]);
        return { rows, total: counts[0]?.count ?? 0 };
      }),
    ),

  get: permissionProcedure("document.read")
    .input(z.object({ id: uuid }))
    .query(async ({ ctx, input }) => {
      const doc = await ctx.rls(async (tx) => {
        const [d] = await tx
          .select()
          .from(sourceDocuments)
          .where(
            and(eq(sourceDocuments.id, input.id), eq(sourceDocuments.organizationId, ctx.orgId)),
          )
          .limit(1);
        if (!d) throw new TRPCError({ code: "NOT_FOUND" });
        return d;
      });
      // Short-lived download link minted with the caller's session (Storage RLS).
      const { data } = await ctx.supabase.storage
        .from(DOCUMENTS_BUCKET)
        .createSignedUrl(doc.storagePath, 600);
      return { ...doc, downloadUrl: data?.signedUrl ?? null };
    }),

  /** Human-in-the-loop: reviewer submits corrected lines → cargo rows. */
  applyExtraction: permissionProcedure("document.review_extraction")
    .input(applyExtractionInput)
    .mutation(({ ctx, input }) =>
      ctx.rls((tx) =>
        applyExtraction(tx, { orgId: ctx.orgId, userId: ctx.session.user.id }, input),
      ),
    ),

  remove: permissionProcedure("document.upload")
    .input(z.object({ id: uuid }))
    .mutation(async ({ ctx, input }) => {
      const doc = await ctx.rls(async (tx) => {
        const before = await tx.query.sourceDocuments.findFirst({
          where: and(
            eq(sourceDocuments.id, input.id),
            eq(sourceDocuments.organizationId, ctx.orgId),
          ),
        });
        if (!before) throw new TRPCError({ code: "NOT_FOUND" });
        const [d] = await tx
          .delete(sourceDocuments)
          .where(
            and(eq(sourceDocuments.id, input.id), eq(sourceDocuments.organizationId, ctx.orgId)),
          )
          .returning({ storagePath: sourceDocuments.storagePath });
        if (!d) throw new TRPCError({ code: "NOT_FOUND" });
        await writeAudit(
          tx,
          ctx.orgId,
          "document.remove",
          "source_document",
          input.id,
          {
            filename: before.originalFilename,
            documentType: before.documentType,
            movementId: before.movementId,
            status: before.uploadStatus,
          },
          null,
        );
        return d;
      });
      await ctx.supabase.storage.from(DOCUMENTS_BUCKET).remove([doc.storagePath]);
      return { id: input.id };
    }),
});
