/** Printable documents: driver sheets, manifest summaries, blank sheet batches (0024). */
import { z } from "zod";
import { desc, eq, schema } from "@corridor/db";
import {
  blankDriverSheetsInput,
  pdfDownloadInput,
  pdfEmailInput,
  pdfGenerateInput,
  uuid,
} from "@corridor/domain";
import { sendEmail } from "@corridor/integrations";
import { logIntegrationEvent } from "../services/customs";
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
        await writeAudit(
          tx,
          ctx.orgId,
          "pdf.blank_driver_sheets",
          "generated_document",
          doc.id,
          null,
          {
            regime: input.regime,
            fromTrip: input.fromTrip,
            toTrip: input.toTrip,
            byteSize: doc.byteSize,
          },
        );
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

  /** "Send by email": a signed link to a rendered document, logged like every send. */
  email: anyPermissionProcedure("movement.read", "report.read")
    .input(pdfEmailInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const doc = await requireGeneratedDocument(tx, ctx.orgId, input.id);
        // A longer-lived link than "open now": the recipient reads it later.
        const signedUrl = await signedUrlFor(doc.storagePath, 24 * 3600);
        const label = String(doc.metadata.movementNumber ?? doc.kind.replace(/_/g, " "));
        const results = [];
        for (const to of input.to) {
          const started = Date.now();
          const result = await sendEmail({
            to,
            subject: `${label}: ${doc.kind.replace(/_/g, " ")}`,
            text: [input.message, "", `Document (link valid for 24 hours): ${signedUrl}`]
              .filter((l) => l !== undefined)
              .join("\n"),
          });
          await logIntegrationEvent(tx, {
            orgId: ctx.orgId,
            movementId: doc.movementId,
            provider: "email",
            direction: "outbound",
            operation: "pdf.email",
            request: { to, documentId: doc.id },
            response: { id: result.id, mode: result.mode },
            success: !result.error,
            error: result.error,
            durationMs: Date.now() - started,
          });
          results.push({ to, ok: !result.error, mode: result.mode, error: result.error ?? null });
        }
        await writeAudit(tx, ctx.orgId, "pdf.email", "generated_document", doc.id, null, {
          to: input.to,
          sent: results.filter((r) => r.ok).length,
        });
        return { results };
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
