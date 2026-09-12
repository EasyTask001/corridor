/** CSV bulk import of shipments and commodity lines (0028). */
import { desc, eq, schema } from "@corridor/db";
import {
  IMPORT_TEMPLATES,
  importBatchInput,
  importListInput,
  importTemplateHeader,
  importTemplateInput,
  importValidateInput,
} from "@corridor/domain";
import { permissionProcedure, router } from "../trpc";
import { writeAudit } from "../services/audit";
import { commitImport, deleteImportBatch, validateImport } from "../services/imports";

const { importBatches } = schema;

export const importsRouter = router({
  /** The header line and column reference for a template. */
  template: permissionProcedure("shipment.read")
    .input(importTemplateInput)
    .query(({ input }) => ({
      header: importTemplateHeader(input.kind),
      columns: IMPORT_TEMPLATES[input.kind],
    })),

  list: permissionProcedure("shipment.read")
    .input(importListInput)
    .query(({ ctx, input }) =>
      ctx.rls((tx) =>
        tx
          .select({
            id: importBatches.id,
            kind: importBatches.kind,
            filename: importBatches.filename,
            rowCount: importBatches.rowCount,
            okCount: importBatches.okCount,
            errorCount: importBatches.errorCount,
            status: importBatches.status,
            createdAt: importBatches.createdAt,
            committedAt: importBatches.committedAt,
            deletedAt: importBatches.deletedAt,
          })
          .from(importBatches)
          .where(eq(importBatches.organizationId, ctx.orgId))
          .orderBy(desc(importBatches.createdAt))
          .limit(input.limit)
          .offset(input.offset),
      ),
    ),

  validate: permissionProcedure("import.run")
    .input(importValidateInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const actor = { orgId: ctx.orgId, userId: ctx.session.user.id };
        const r = await validateImport(tx, actor, input);
        await writeAudit(tx, ctx.orgId, "import.validate", "import_batch", r.batch.id, null, {
          kind: input.kind,
          filename: input.filename,
          rows: r.batch.rowCount,
          ok: r.batch.okCount,
          errors: r.batch.errorCount,
        });
        return { batchId: r.batch.id, report: r.report, unknownColumns: r.unknownColumns };
      }),
    ),

  commit: permissionProcedure("import.run")
    .input(importBatchInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const actor = { orgId: ctx.orgId, userId: ctx.session.user.id };
        const r = await commitImport(tx, actor, input.batchId);
        await writeAudit(tx, ctx.orgId, "import.commit", "import_batch", input.batchId, null, {
          inserted: r.inserted,
          kind: r.batch.kind,
        });
        return { inserted: r.inserted, status: r.batch.status };
      }),
    ),

  deleteBatch: permissionProcedure("import.run")
    .input(importBatchInput)
    .mutation(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const actor = { orgId: ctx.orgId, userId: ctx.session.user.id };
        const r = await deleteImportBatch(tx, actor, input.batchId);
        await writeAudit(
          tx,
          ctx.orgId,
          "import.delete_batch",
          "import_batch",
          input.batchId,
          null,
          {
            deleted: r.deleted,
            kept: r.kept.length,
          },
        );
        return { deleted: r.deleted, kept: r.kept };
      }),
    ),
});
