/**
 * Registries: drivers, trucks, trailers, partners.
 * One generic CRUD factory so all four behave identically (list/search/get/
 * create/update/archive) and permission keys can never drift.
 *
 * Drizzle's builder types don't accept a union of tables, so the factory
 * builds queries against a structural "registry table" cast and re-types rows
 * on the way out via `T["$inferSelect"]`. All four tables share the columns
 * used inside the factory (id, organization_id, status, created_by).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  and,
  asc,
  eq,
  ilike,
  or,
  schema,
  sql,
  type PgColumn,
  type PgTable,
  type RlsTransaction,
} from "@corridor/db";
import {
  driverDocumentInput,
  driverDocumentRemoveInput,
  driverInput,
  partnerInput,
  registryListInput,
  trailerInput,
  truckInput,
  uuid,
  type PermissionKey,
} from "@corridor/domain";
import { mergeRouters, permissionProcedure, router } from "../trpc";
import { writeAudit } from "../services/audit";
import {
  findingsForDriver,
  findingsForTrailer,
  findingsForTruck,
  syncEntityAlerts,
  travelDocumentsFor,
} from "../services/compliance";

const { drivers, driverDocuments, trucks, trailers, partners } = schema;

/** Structural shape every registry table satisfies; used for query building. */
type RegistryTable = typeof drivers;

interface RegistryConfig<T extends PgTable, I extends z.ZodObject> {
  table: T;
  input: I;
  read: PermissionKey;
  write: PermissionKey;
  entityType: "driver" | "truck" | "trailer" | "partner";
  searchColumns: (t: T) => PgColumn[];
  orderBy: (t: T) => ReturnType<typeof asc>[];
  /** after insert/update/archive: run compliance rules for this entity */
  afterSave?: (tx: RlsTransaction, orgId: string, row: T["$inferSelect"]) => Promise<unknown>;
}

function mapDbError(e: unknown): never {
  const cause = (e as { cause?: { code?: string; constraint_name?: string; constraint?: string } })
    ?.cause;
  const constraint = cause?.constraint_name ?? cause?.constraint ?? "";
  if (cause?.code === "23505") {
    const which = constraint.includes("vin")
      ? "VIN"
      : constraint.includes("document")
        ? "document number"
        : constraint.includes("license")
          ? "license number"
          : "unit number";
    throw new TRPCError({
      code: "CONFLICT",
      message: `A record with this ${which} already exists`,
    });
  }
  if (cause?.code === "23514") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A field failed validation" });
  }
  throw e;
}

function registryRouter<T extends PgTable, I extends z.ZodObject>(cfg: RegistryConfig<T, I>) {
  type Row = T["$inferSelect"];
  const t = cfg.table as unknown as RegistryTable;
  const searchColumns = cfg.searchColumns(cfg.table);
  const orderBy = cfg.orderBy(cfg.table);
  const updateInput = cfg.input.partial().extend({ id: uuid });

  return router({
    list: permissionProcedure(cfg.read)
      .input(registryListInput)
      .query(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const conds = [eq(t.organizationId, ctx.orgId)];
          if (input.status) conds.push(eq(t.status, input.status));
          else if (!input.includeArchived) conds.push(sql`${t.status} <> 'archived'`);
          if (input.search) {
            const like = `%${input.search.replace(/[%_\\]/g, "\\$&")}%`;
            conds.push(or(...searchColumns.map((c) => ilike(c, like)))!);
          }
          const where = and(...conds);
          const [rows, counts] = await Promise.all([
            tx
              .select()
              .from(t)
              .where(where)
              .orderBy(...orderBy)
              .limit(input.limit)
              .offset(input.offset),
            tx
              .select({ count: sql<number>`count(*)::int` })
              .from(t)
              .where(where),
          ]);
          return { rows: rows as unknown as Row[], total: counts[0]?.count ?? 0 };
        }),
      ),

    get: permissionProcedure(cfg.read)
      .input(z.object({ id: uuid }))
      .query(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const [row] = await tx
            .select()
            .from(t)
            .where(and(eq(t.id, input.id), eq(t.organizationId, ctx.orgId)))
            .limit(1);
          if (!row) throw new TRPCError({ code: "NOT_FOUND" });
          return row as unknown as Row;
        }),
      ),

    create: permissionProcedure(cfg.write)
      .input(cfg.input)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const values = {
            ...(input as Record<string, unknown>),
            organizationId: ctx.orgId,
            createdBy: ctx.session.user.id,
          } as unknown as RegistryTable["$inferInsert"];
          const [row] = await tx.insert(t).values(values).returning().catch(mapDbError);
          const saved = row as unknown as Row & { id: string };
          await writeAudit(
            tx,
            ctx.orgId,
            `${cfg.entityType}.create`,
            cfg.entityType,
            saved.id,
            null,
            saved,
          );
          await cfg.afterSave?.(tx, ctx.orgId, saved);
          return saved as Row;
        }),
      ),

    update: permissionProcedure(cfg.write)
      .input(updateInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const { id, ...patch } = input as { id: string } & Record<string, unknown>;
          const [before] = await tx
            .select()
            .from(t)
            .where(and(eq(t.id, id), eq(t.organizationId, ctx.orgId)))
            .limit(1);
          if (!before) throw new TRPCError({ code: "NOT_FOUND" });
          const [row] = await tx
            .update(t)
            .set(patch as Partial<RegistryTable["$inferInsert"]>)
            .where(and(eq(t.id, id), eq(t.organizationId, ctx.orgId)))
            .returning()
            .catch(mapDbError);
          const saved = row as unknown as Row;
          await writeAudit(
            tx,
            ctx.orgId,
            `${cfg.entityType}.update`,
            cfg.entityType,
            id,
            before,
            saved,
          );
          await cfg.afterSave?.(tx, ctx.orgId, saved);
          return saved;
        }),
      ),

    /** Soft delete — keeps history/FK integrity for past movements. */
    archive: permissionProcedure(cfg.write)
      .input(z.object({ id: uuid }))
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const [row] = await tx
            .update(t)
            .set({ status: "archived" })
            .where(and(eq(t.id, input.id), eq(t.organizationId, ctx.orgId)))
            .returning();
          if (!row) throw new TRPCError({ code: "NOT_FOUND" });
          const saved = row as unknown as Row;
          await writeAudit(
            tx,
            ctx.orgId,
            `${cfg.entityType}.archive`,
            cfg.entityType,
            input.id,
            null,
            { status: "archived" },
          );
          await cfg.afterSave?.(tx, ctx.orgId, saved);
          return saved;
        }),
      ),
  });
}

/** A driver's compliance alerts depend on their travel documents too. */
async function syncDriverAlerts(tx: RlsTransaction, orgId: string, driverId: string) {
  const [driver] = await tx
    .select()
    .from(drivers)
    .where(and(eq(drivers.id, driverId), eq(drivers.organizationId, orgId)))
    .limit(1);
  if (!driver) throw new TRPCError({ code: "NOT_FOUND", message: "Driver not found" });
  return syncEntityAlerts(
    tx,
    orgId,
    { type: "driver", id: driverId },
    findingsForDriver(driver, await travelDocumentsFor(tx, driverId)),
  );
}

/**
 * Travel documents hang off one person, so they are a sub-router rather than a
 * fifth registry: there is no org-wide list, search or archive for them.
 */
const driverDocumentRouter = router({
  documents: router({
    list: permissionProcedure("driver.read")
      .input(z.object({ driverId: uuid }))
      .query(({ ctx, input }) =>
        ctx.rls((tx) =>
          tx
            .select()
            .from(driverDocuments)
            .where(
              and(
                eq(driverDocuments.driverId, input.driverId),
                eq(driverDocuments.organizationId, ctx.orgId),
              ),
            )
            .orderBy(asc(driverDocuments.documentType)),
        ),
      ),

    upsert: permissionProcedure("driver.write")
      .input(driverDocumentInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const { id, driverId, ...fields } = input;
          const [row] = id
            ? await tx
                .update(driverDocuments)
                .set(fields)
                .where(
                  and(
                    eq(driverDocuments.id, id),
                    eq(driverDocuments.driverId, driverId),
                    eq(driverDocuments.organizationId, ctx.orgId),
                  ),
                )
                .returning()
                .catch(mapDbError)
            : await tx
                .insert(driverDocuments)
                .values({ ...fields, driverId, organizationId: ctx.orgId })
                .returning()
                .catch(mapDbError);
          if (!row) throw new TRPCError({ code: "NOT_FOUND" });
          await writeAudit(
            tx,
            ctx.orgId,
            id ? "driver.document_update" : "driver.document_add",
            "driver_document",
            row.id,
            null,
            row,
          );
          await syncDriverAlerts(tx, ctx.orgId, driverId);
          return row;
        }),
      ),

    remove: permissionProcedure("driver.write")
      .input(driverDocumentRemoveInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const [removed] = await tx
            .delete(driverDocuments)
            .where(
              and(
                eq(driverDocuments.id, input.id),
                eq(driverDocuments.driverId, input.driverId),
                eq(driverDocuments.organizationId, ctx.orgId),
              ),
            )
            .returning();
          if (!removed) throw new TRPCError({ code: "NOT_FOUND" });
          await writeAudit(
            tx,
            ctx.orgId,
            "driver.document_remove",
            "driver_document",
            input.id,
            removed,
            null,
          );
          await syncDriverAlerts(tx, ctx.orgId, input.driverId);
          return { id: input.id };
        }),
      ),
  }),
});

export const partyRouter = router({
  drivers: mergeRouters(
    registryRouter({
      table: drivers,
      input: driverInput,
      read: "driver.read",
      write: "driver.write",
      entityType: "driver",
      searchColumns: (t) => [t.firstName, t.lastName, t.licenseNumber],
      orderBy: (t) => [asc(t.lastName), asc(t.firstName)],
      afterSave: async (tx, orgId, row) =>
        syncEntityAlerts(
          tx,
          orgId,
          { type: "driver", id: row.id },
          findingsForDriver(row, await travelDocumentsFor(tx, row.id)),
        ),
    }),
    driverDocumentRouter,
  ),
  trucks: registryRouter({
    table: trucks,
    input: truckInput,
    read: "truck.read",
    write: "truck.write",
    entityType: "truck",
    searchColumns: (t) => [t.unitNumber, t.vin, t.plateNumber],
    orderBy: (t) => [asc(t.unitNumber)],
    afterSave: (tx, orgId, row) =>
      syncEntityAlerts(tx, orgId, { type: "truck", id: row.id }, findingsForTruck(row)),
  }),
  trailers: registryRouter({
    table: trailers,
    input: trailerInput,
    read: "trailer.read",
    write: "trailer.write",
    entityType: "trailer",
    searchColumns: (t) => [t.unitNumber, t.vin, t.plateNumber],
    orderBy: (t) => [asc(t.unitNumber)],
    afterSave: (tx, orgId, row) =>
      syncEntityAlerts(tx, orgId, { type: "trailer", id: row.id }, findingsForTrailer(row)),
  }),
  partners: registryRouter({
    table: partners,
    input: partnerInput,
    read: "partner.read",
    write: "partner.write",
    entityType: "partner",
    searchColumns: (t) => [t.name, t.contactName, t.taxId],
    orderBy: (t) => [asc(t.name)],
  }),
});
