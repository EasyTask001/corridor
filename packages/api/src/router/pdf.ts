/** Printable documents: driver sheets, manifest summaries, blank sheet batches (0024). */
import { z } from "zod";
import { desc, eq, schema } from "@corridor/db";
import { blankDriverSheetsInput, pdfDownloadInput, pdfGenerateInput, uuid } from "@corridor/domain";
import { anyPermissionProcedure, permissionProcedure, router, type OrgContext } from "../trpc";
import { writeAudit } from "../services/audit";
import {
  generateBlankSheets,
  generateForMovement,
  requireGeneratedDocument,
  signedUrlFor,
} from "../services/pdf";

const { generatedDocuments } = schema;
const actorOf = (ctx: OrgContext) => ({ orgId: ctx.orgId, userId: ctx.session.user.id });

export const pdfRouter = router({
  /** Render a driver sheet or manifest summary for one movement. */
  generate: anyPermissionProcedure("movement.read", "movement.read_assigned")
    .input(pdfGenerateInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const doc = await generateForMovement(tx, actorOf(ctx), input);
        await writeAudit(tx, ctx.orgId, "pdf.generate", "generated_document", doc.id, null, {
          movementId: input.movementId,
          kind: input.kind,
          byteSize: doc.byteSize,
        });
        return doc;
      }),
    ),

  /** Pre-numbered blank sheets for a trip range. */
  blankDriverSheets: permissionProcedure("movement.read")
    .input(blankDriverSheetsInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const doc = await generateBlankSheets(tx, actorOf(ctx), input);
        await writeAudit(tx, ctx.orgId, "pdf.blank_driver_sheets", "generated_document", doc.id, null, {
          regime: input.regime,
          fromTrip: input.fromTrip,
          toTrip: input.toTrip,
          byteSize: doc.byteSize,
        });
        return doc;
      }),
    ),

  /** A fresh 60 s signed URL for a document the caller may read (RLS). */
  download: anyPermissionProcedure("movement.read", "movement.read_assigned", "report.read")
    .input(pdfDownloadInput)
    .query(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const doc = await requireGeneratedDocument(tx, ctx.orgId, input.id);
        return { ...doc, signedUrl: await signedUrlFor(doc.storagePath) };
      }),
    ),

  /** Documents already rendered for a movement, newest first. */
  forMovement: anyPermissionProcedure("movement.read", "movement.read_assigned")
    .input(z.object({ movementId: uuid, limit: z.number().int().min(1).max(50).default(10) }))
    .query(({ ctx, input }) =>
      ctx.rls((tx) =>
        tx
          .select({
            id: generatedDocuments.id,
            kind: generatedDocuments.kind,
            byteSize: generatedDocuments.byteSize,
            createdAt: generatedDocuments.createdAt,
          })
          .from(generatedDocuments)
          .where(eq(generatedDocuments.movementId, input.movementId))
          .orderBy(desc(generatedDocuments.createdAt))
          .limit(input.limit),
      ),
    ),
});
