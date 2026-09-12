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
  inArray,
  or,
  schema,
  sql,
  type PgColumn,
  type PgTable,
  type RlsTransaction,
} from "@corridor/db";
import { containsPattern } from "../infra/like";
import {
  addressToColumns,
  driverDocumentInput,
  driverDocumentRemoveInput,
  driverInput,
  nestAddress,
  partnerInput,
  registryListInput,
  trailerInput,
  truckInput,
  uuid,
  REGISTRY_SEARCH_COLUMNS,
  registryBulkStatusInput,
  registryExportInput,
  type Address,
  type AddressColumns,
  type PermissionKey,
  type PlateEntry,
} from "@corridor/domain";
import { mergeRouters, permissionProcedure, router } from "../trpc";
import { writeAudit } from "../services/audit";
import { mapDbError } from "../services/db-errors";
import { exportTable } from "../services/reporting-export";
import {
  findingsForDriver,
  findingsForTrailer,
  findingsForTruck,
  syncEntityAlerts,
  travelDocumentsFor,
} from "../services/compliance";
import { platesFor, writePlates } from "../services/equipment";

const { drivers, driverDocuments, trucks, trailers, partners } = schema;

/** Structural shape every registry table satisfies; used for query building. */
type RegistryTable = typeof drivers;

type AddressKey = "address" | "usAddress";
type Presented<Row, A extends AddressKey | undefined> = A extends AddressKey
  ? Omit<Row, keyof AddressColumns<A>> & { [k in A]: Address }
  : Row;

interface RegistryConfig<
  T extends PgTable,
  I extends z.ZodObject,
  A extends AddressKey | undefined = undefined,
> {
  table: T;
  input: I;
  read: PermissionKey;
  write: PermissionKey;
  entityType: "driver" | "truck" | "trailer" | "partner";
  searchColumns: (t: T) => PgColumn[];
  orderBy: (t: T) => ReturnType<typeof asc>[];
  /** after insert/update/archive: run compliance rules for this entity */
  afterSave?: (tx: RlsTransaction, orgId: string, row: T["$inferSelect"]) => Promise<unknown>;
  /**
   * Trucks and trailers carry extra plates in `equipment_plates` (0021). The
   * input's `extraPlates` array is split off the row and written there, and
   * rows read back carry it again so the edit form can round-trip it.
   */
  plateOwner?: "truckId" | "trailerId";
  /** Which registry this is, for the search-column allow-list. */
  kind: keyof typeof REGISTRY_SEARCH_COLUMNS;
  /** Title and columns of the CSV / PDF export (Task 12). */
  title: string;
  exportColumns: Array<{ key: string; label: string; value?: (row: T["$inferSelect"]) => unknown }>;
  /** 0042 — the nested address on the API shape; stored as `<key>_*` columns (the key doubles as the column prefix). */
  address?: A;
}

/** Flatten a registry cell for a CSV / PDF: dates to ISO days, booleans to yes/no. */
function exportCell(value: unknown): string | number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

type PlateRow = Awaited<ReturnType<typeof platesFor>>[number];

/** Attach `extraPlates` to registry rows that own plates. */
function withPlates<R extends { id: string }>(
  rows: R[],
  owner: "truckId" | "trailerId",
  plates: PlateRow[],
) {
  return rows.map((row) => ({
    ...row,
    extraPlates: plates
      .filter((p) => p[owner] === row.id)
      .map((p) => ({ plateNumber: p.plateNumber, jurisdiction: p.jurisdiction })),
  }));
}

function registryRouter<
  T extends PgTable,
  I extends z.ZodObject,
  A extends AddressKey | undefined = undefined,
>(cfg: RegistryConfig<T, I, A>) {
  type Row = T["$inferSelect"];
  type Out = Presented<Row, A>;
  const present = (row: Row): Out =>
    (cfg.address ? nestAddress(cfg.address, cfg.address, row as never) : row) as Out;
  const flatten = (fields: Record<string, unknown>) => {
    if (!cfg.address || !(cfg.address in fields)) return fields;
    const { [cfg.address]: nested, ...rest } = fields;
    return { ...rest, ...addressToColumns(cfg.address, nested as Address | null | undefined) };
  };
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
            const like = containsPattern(input.search);
            if (input.searchColumn) {
              // Search-by-column (Task 14): only this registry's advertised columns.
              const allowed = REGISTRY_SEARCH_COLUMNS[cfg.kind].some(
                (c) => c.key === input.searchColumn,
              );
              const column = (cfg.table as unknown as Record<string, PgColumn>)[input.searchColumn];
              if (!allowed || !column)
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: `Cannot search ${cfg.kind} by ${input.searchColumn}`,
                });
              conds.push(ilike(column, like));
            } else {
              conds.push(or(...searchColumns.map((c) => ilike(c, like)))!);
            }
          }
          if (input.direction && cfg.entityType === "partner") {
            const pt = cfg.table as unknown as typeof partners;
            conds.push(inArray(pt.type, [input.direction, "both"]));
          }
          const where = and(...conds);
          const [rawRows, counts] = await Promise.all([
            tx
              .select()
              .from(t)
              .where(where)
              .orderBy(...orderBy)
              .limit(input.pageSize ?? input.limit)
              .offset(input.offset),
            tx
              .select({ count: sql<number>`count(*)::int` })
              .from(t)
              .where(where),
          ]);
          const rows = cfg.plateOwner
            ? withPlates(
                rawRows,
                cfg.plateOwner,
                await platesFor(tx, {
                  [cfg.plateOwner === "truckId" ? "truckIds" : "trailerIds"]: rawRows.map(
                    (r) => r.id,
                  ),
                }),
              )
            : rawRows;
          return {
            rows: (rows as unknown as Row[]).map(present),
            total: counts[0]?.count ?? 0,
          };
        }),
      ),

    /** Bulk activate / deactivate / archive (Task 14): one audit row per record, like `update`. */
    bulkSetStatus: permissionProcedure(cfg.write)
      .input(registryBulkStatusInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const before = (await tx
            .select()
            .from(t)
            .where(
              and(eq(t.organizationId, ctx.orgId), inArray(t.id, input.ids)),
            )) as unknown as (Row & {
            id: string;
            status: string;
          })[];
          let changed = 0;
          for (const row of before) {
            if (row.status === input.status) continue;
            const [after] = await tx
              .update(t)
              .set({ status: input.status })
              .where(eq(t.id, row.id))
              .returning();
            await writeAudit(
              tx,
              ctx.orgId,
              `${cfg.entityType}.update`,
              cfg.entityType,
              row.id,
              row,
              after ?? null,
            );
            if (cfg.afterSave && after) await cfg.afterSave(tx, ctx.orgId, after);
            changed += 1;
          }
          return { changed, total: before.length };
        }),
      ),

    /** The whole registry as a CSV or PDF, stored like any generated document. */
    export: permissionProcedure(cfg.read)
      .input(registryExportInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const conds = [eq(t.organizationId, ctx.orgId)];
          if (!input.includeArchived) conds.push(sql`${t.status} <> 'archived'`);
          const raw = (await tx
            .select()
            .from(t)
            .where(and(...conds))
            .orderBy(...orderBy)
            .limit(5000)) as unknown as Row[];
          const columns = cfg.exportColumns.map(({ key, label }) => ({ key, label }));
          const rows = raw.map((r) =>
            Object.fromEntries(
              cfg.exportColumns.map((c) => [
                c.key,
                exportCell(c.value ? c.value(r) : (r as Record<string, unknown>)[c.key]),
              ]),
            ),
          );
          const doc = await exportTable(
            tx,
            { orgId: ctx.orgId, userId: ctx.session.user.id },
            {
              kind: "registry_export",
              scope: `${cfg.entityType}s`,
              format: input.format,
              data: {
                title: cfg.title,
                subtitle: input.includeArchived ? "Including archived" : "Active and inactive",
                columns,
                rows,
              },
              metadata: { registry: cfg.entityType, includeArchived: input.includeArchived },
            },
          );
          await writeAudit(
            tx,
            ctx.orgId,
            `${cfg.entityType}.export`,
            "generated_document",
            doc.id,
            null,
            {
              format: input.format,
              rowCount: rows.length,
            },
          );
          return {
            id: doc.id,
            signedUrl: doc.signedUrl,
            byteSize: doc.byteSize,
            format: input.format,
          };
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
          if (!cfg.plateOwner) return present(row);
          const plates = await platesFor(tx, {
            [cfg.plateOwner === "truckId" ? "truckIds" : "trailerIds"]: [row.id],
          });
          return present(withPlates([row], cfg.plateOwner, plates)[0] as unknown as Row);
        }),
      ),

    create: permissionProcedure(cfg.write)
      .input(cfg.input)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const { extraPlates, ...fields } = input as Record<string, unknown> & {
            extraPlates?: PlateEntry[];
          };
          const values = {
            ...flatten(fields),
            organizationId: ctx.orgId,
            createdBy: ctx.session.user.id,
          } as unknown as RegistryTable["$inferInsert"];
          const [row] = await tx.insert(t).values(values).returning().catch(mapDbError);
          const saved = row as unknown as Row & { id: string };
          if (cfg.plateOwner && extraPlates)
            await writePlates(tx, ctx.orgId, { [cfg.plateOwner]: saved.id } as never, extraPlates);
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
          return present(saved);
        }),
      ),

    update: permissionProcedure(cfg.write)
      .input(updateInput)
      .mutation(({ ctx, input }) =>
        ctx.rls(async (tx) => {
          const { id, extraPlates, ...patch } = input as { id: string } & Record<
            string,
            unknown
          > & { extraPlates?: PlateEntry[] };
          const [before] = await tx
            .select()
            .from(t)
            .where(and(eq(t.id, id), eq(t.organizationId, ctx.orgId)))
            .limit(1);
          if (!before) throw new TRPCError({ code: "NOT_FOUND" });
          const [row] = await tx
            .update(t)
            .set(flatten(patch) as Partial<RegistryTable["$inferInsert"]>)
            .where(and(eq(t.id, id), eq(t.organizationId, ctx.orgId)))
            .returning()
            .catch(mapDbError);
          const saved = row as unknown as Row;
          if (cfg.plateOwner && extraPlates)
            await writePlates(tx, ctx.orgId, { [cfg.plateOwner]: id } as never, extraPlates);
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
          return present(saved);
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
          return present(saved);
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
      kind: "drivers",
      title: "Drivers",
      exportColumns: [
        { key: "firstName", label: "First name" },
        { key: "lastName", label: "Last name" },
        { key: "personType", label: "Type" },
        { key: "licenseNumber", label: "License" },
        { key: "licenseJurisdiction", label: "License jurisdiction" },
        { key: "licenseExpiry", label: "License expiry" },
        { key: "medicalCertExpiry", label: "Medical expiry" },
        { key: "citizenship", label: "Citizenship" },
        { key: "phone", label: "Phone" },
        { key: "email", label: "Email" },
        { key: "status", label: "Status" },
      ],
      searchColumns: (t) => [t.firstName, t.lastName, t.licenseNumber],
      orderBy: (t) => [asc(t.lastName), asc(t.firstName)],
      afterSave: async (tx, orgId, row) =>
        syncEntityAlerts(
          tx,
          orgId,
          { type: "driver", id: row.id },
          findingsForDriver(row, await travelDocumentsFor(tx, row.id)),
        ),
      address: "usAddress",
    }),
    driverDocumentRouter,
  ),
  trucks: registryRouter({
    table: trucks,
    input: truckInput,
    read: "truck.read",
    write: "truck.write",
    entityType: "truck",
    kind: "trucks",
    title: "Trucks",
    exportColumns: [
      { key: "unitNumber", label: "Unit" },
      { key: "vin", label: "VIN" },
      { key: "make", label: "Make" },
      { key: "model", label: "Model" },
      { key: "modelYear", label: "Year" },
      { key: "plateNumber", label: "Plate" },
      { key: "plateJurisdiction", label: "Plate jurisdiction" },
      { key: "dotNumber", label: "DOT #" },
      { key: "registrationExpiry", label: "Registration expiry" },
      { key: "insuranceExpiry", label: "Insurance expiry" },
      { key: "annualInspectionExpiry", label: "Inspection expiry" },
      { key: "status", label: "Status" },
    ],
    searchColumns: (t) => [t.unitNumber, t.vin, t.plateNumber],
    orderBy: (t) => [asc(t.unitNumber)],
    plateOwner: "truckId",
    afterSave: (tx, orgId, row) =>
      syncEntityAlerts(tx, orgId, { type: "truck", id: row.id }, findingsForTruck(row)),
  }),
  trailers: registryRouter({
    table: trailers,
    input: trailerInput,
    read: "trailer.read",
    write: "trailer.write",
    entityType: "trailer",
    kind: "trailers",
    title: "Trailers",
    exportColumns: [
      { key: "unitNumber", label: "Unit" },
      { key: "trailerType", label: "Type" },
      { key: "vin", label: "VIN" },
      { key: "plateNumber", label: "Plate" },
      { key: "plateJurisdiction", label: "Plate jurisdiction" },
      { key: "lengthFt", label: "Length (ft)" },
      { key: "registrationExpiry", label: "Registration expiry" },
      { key: "insuranceExpiry", label: "Insurance expiry" },
      { key: "annualInspectionExpiry", label: "Inspection expiry" },
      { key: "status", label: "Status" },
    ],
    searchColumns: (t) => [t.unitNumber, t.vin, t.plateNumber],
    orderBy: (t) => [asc(t.unitNumber)],
    plateOwner: "trailerId",
    afterSave: (tx, orgId, row) =>
      syncEntityAlerts(tx, orgId, { type: "trailer", id: row.id }, findingsForTrailer(row)),
  }),
  partners: registryRouter({
    table: partners,
    input: partnerInput,
    read: "partner.read",
    write: "partner.write",
    entityType: "partner",
    kind: "partners",
    title: "Partners",
    exportColumns: [
      { key: "name", label: "Partner" },
      { key: "type", label: "Role" },
      { key: "line1", label: "Address", value: (r) => r.addressLine1 },
      { key: "city", label: "City", value: (r) => r.addressCity },
      { key: "region", label: "Province / state", value: (r) => r.addressRegion },
      { key: "postalCode", label: "Postal / ZIP", value: (r) => r.addressPostalCode },
      { key: "country", label: "Country", value: (r) => r.addressCountry },
      { key: "taxId", label: "Tax ID" },
      { key: "contactName", label: "Contact" },
      { key: "contactEmail", label: "Contact email" },
      { key: "contactPhone", label: "Contact phone" },
      { key: "status", label: "Status" },
    ],
    searchColumns: (t) => [t.name, t.contactName, t.taxId],
    orderBy: (t) => [asc(t.name)],
    address: "address",
  }),
});
