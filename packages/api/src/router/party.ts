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
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { and, asc, eq, ilike, or, schema, sql, type RlsTransaction } from "@corridor/db";
import {
  driverInput,
  partnerInput,
  registryListInput,
  trailerInput,
  truckInput,
  uuid,
  type PermissionKey,
} from "@corridor/domain";
import { permissionProcedure, router, type OrgContext } from "../trpc";
import {
  findingsForDriver,
  findingsForTrailer,
  findingsForTruck,
  syncEntityAlerts,
} from "../services/compliance";

const { drivers, trucks, trailers, partners } = schema;

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

async function audit(
  tx: RlsTransaction,
  ctx: OrgContext,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
) {
  // audit_log INSERT is revoked from `authenticated`; go through the
  // membership-checked SECURITY DEFINER function instead.
  await tx.execute(sql`
    select public.log_audit(
      ${ctx.orgId}::uuid, ${action}, ${entityType}, ${entityId},
      ${before ? JSON.stringify(before) : null}::jsonb,
      ${after ? JSON.stringify(after) : null}::jsonb
    )
  `);
}

function mapDbError(e: unknown): never {
  const cause = (e as { cause?: { code?: string; constraint_name?: string; constraint?: string } })
    ?.cause;
  const constraint = cause?.constraint_name ?? cause?.constraint ?? "";
  if (cause?.code === "23505") {
    const which = constraint.includes("vin")
      ? "VIN"
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
          await audit(tx, ctx, `${cfg.entityType}.create`, cfg.entityType, saved.id, null, saved);
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
          await audit(tx, ctx, `${cfg.entityType}.update`, cfg.entityType, id, before, saved);
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
          await audit(tx, ctx, `${cfg.entityType}.archive`, cfg.entityType, input.id, null, {
            status: "archived",
          });
          await cfg.afterSave?.(tx, ctx.orgId, saved);
          return saved;
        }),
      ),
  });
}

export const partyRouter = router({
  drivers: registryRouter({
    table: drivers,
    input: driverInput,
    read: "driver.read",
    write: "driver.write",
    entityType: "driver",
    searchColumns: (t) => [t.firstName, t.lastName, t.licenseNumber, t.fastCardNumber],
    orderBy: (t) => [asc(t.lastName), asc(t.firstName)],
    afterSave: (tx, orgId, row) =>
      syncEntityAlerts(tx, orgId, { type: "driver", id: row.id }, findingsForDriver(row)),
  }),
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
