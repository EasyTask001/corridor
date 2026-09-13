/**
 * CSV bulk import (0028): parse server-side, validate every row, resolve
 * names and codes against the tenant's own registries, persist the report as
 * a `validated` batch, and only on an explicit commit insert the ok rows —
 * all of them, in one transaction, stamped with the batch id so the batch
 * can be deleted again while its rows are still drafts.
 */
import Papa from "papaparse";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, schema, sql, type RlsTransaction } from "@corridor/db";
import {
  IMPORT_TEMPLATES,
  commodityImportRow,
  shipmentImportRow,
  type CommodityImportRow,
  type ImportKind,
  type ImportReport,
  type ImportReportRow,
  type ImportRowError,
  type ShipmentImportRow,
} from "@corridor/domain";
import type { Actor } from "./movements";
import { writeHazmat } from "./shipments";

const {
  importBatches,
  shipments,
  commodities,
  partners,
  ports,
  organizationCarrierCodes,
  movements,
} = schema;

/** Header cells folded to the template keys: "Control Reference" → control_reference. */
const foldHeader = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");

/** papaparse with the settings every template shares; delimiter auto-detects across .csv/.txt/.dat. */
export function parseCsv(content: string): { rows: Record<string, string>[]; columns: string[] } {
  const parsed = Papa.parse<Record<string, string>>(content.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: foldHeader,
  });
  return { rows: parsed.data, columns: parsed.meta.fields ?? [] };
}

export interface ResolvedShipment {
  regime: "ACE" | "ACI";
  carrierCode: string;
  controlReference: string;
  shipmentType: string | null;
  cargoType: string | null;
  shipperId: string | null;
  consigneeId: string | null;
  brokerId: string | null;
  entryPortId: string | null;
  inBondEntryType: "IT" | "TE" | "IE" | null;
  inBondDestinationPortId: string | null;
  isPars: boolean;
  destinationPortId: string | null;
  sublocationPortId: string | null;
  loadingCountry: string | null;
  loadingProvince: string | null;
  loadingCity: string | null;
  consigneeBusinessNumber: string | null;
}

export interface ResolvedCommodity {
  shipmentId: string;
  lineNumber: number | null;
  commodityDescription: string;
  hsCode: string | null;
  quantity: number | null;
  quantityUnit: string | null;
  weightKg: number | null;
  weightUnit: "KG" | "LB";
  countryOfOrigin: string | null;
  marksAndNumbers: string | null;
  valueAmount: number | null;
  valueCurrency: "USD" | "CAD" | null;
  isConsolidated: boolean;
  hazmat: Array<{
    unCode: string;
    description: string | null;
    emergencyContact: string | null;
    emergencyPhone: string | null;
  }>;
}

const zodErrors = (issues: Array<{ path: PropertyKey[]; message: string }>): ImportRowError[] =>
  issues.map((i) => ({ column: String(i.path[0] ?? ""), message: i.message }));

const EDITABLE_MOVEMENT = new Set(["draft", "rejected"]);

/** Reference data the rows resolve against, loaded once per file. */
async function lookups(tx: RlsTransaction, orgId: string) {
  const [partnerRows, codeRows, portRows] = await Promise.all([
    tx
      .select({ id: partners.id, name: partners.name, type: partners.type })
      .from(partners)
      .where(and(eq(partners.organizationId, orgId), eq(partners.status, "active"))),
    tx
      .select({
        regime: organizationCarrierCodes.regime,
        code: organizationCarrierCodes.code,
        isDefault: organizationCarrierCodes.isDefault,
      })
      .from(organizationCarrierCodes)
      .where(
        and(
          eq(organizationCarrierCodes.organizationId, orgId),
          eq(organizationCarrierCodes.status, "active"),
        ),
      ),
    tx
      .select({ id: ports.id, regime: ports.regime, kind: ports.kind, code: ports.code })
      .from(ports)
      .where(eq(ports.active, true)),
  ]);
  const partnerByName = new Map(partnerRows.map((p) => [p.name.trim().toLowerCase(), p]));
  const codes = new Set(codeRows.map((c) => `${c.regime}:${c.code}`));
  const defaults = new Map(codeRows.filter((c) => c.isDefault).map((c) => [c.regime, c.code]));
  const portBy = new Map(portRows.map((p) => [`${p.regime}:${p.kind}:${p.code}`, p.id]));
  return {
    partner: (name: string | undefined) =>
      name ? partnerByName.get(name.trim().toLowerCase()) : undefined,
    hasCode: (regime: string, code: string) => codes.has(`${regime}:${code}`),
    defaultCode: (regime: "ACE" | "ACI") => defaults.get(regime),
    port: (regime: string, kind: string, code: string | undefined) =>
      code ? portBy.get(`${regime}:${kind}:${code}`) : undefined,
  };
}

export async function validateShipmentRows(
  tx: RlsTransaction,
  orgId: string,
  raw: Record<string, string>[],
): Promise<{ report: ImportReport; payload: ResolvedShipment[] }> {
  const ref = await lookups(tx, orgId);
  const seen = new Map<string, number>();
  const rows: ImportReportRow[] = [];
  const payload: ResolvedShipment[] = [];

  // Existing control numbers, looked up in one query for the whole file.
  const candidates = raw
    .map((r) => shipmentImportRow.safeParse(r))
    .flatMap((p) => (p.success ? [p.data] : []))
    .map((r) => `${r.carrier_code ?? ref.defaultCode(r.regime) ?? ""}${r.control_reference}`);
  const existing = new Set(
    candidates.length
      ? (
          await tx
            .select({ controlNumber: shipments.controlNumber })
            .from(shipments)
            .where(
              and(
                eq(shipments.organizationId, orgId),
                inArray(shipments.controlNumber, candidates),
              ),
            )
        ).map((s) => s.controlNumber)
      : [],
  );

  raw.forEach((r, i) => {
    const line = i + 2;
    const parsed = shipmentImportRow.safeParse(r);
    if (!parsed.success) {
      rows.push({
        line,
        status: "error",
        errors: zodErrors(parsed.error.issues),
        label: r.control_reference ?? "",
      });
      return;
    }
    const row: ShipmentImportRow = parsed.data;
    const errors: ImportRowError[] = [];
    const carrierCode = row.carrier_code ?? ref.defaultCode(row.regime);
    if (!carrierCode)
      errors.push({ column: "carrier_code", message: `no ${row.regime} carrier code on file` });
    else if (!ref.hasCode(row.regime, carrierCode))
      errors.push({
        column: "carrier_code",
        message: `${carrierCode} is not one of this organization's ${row.regime} codes`,
      });
    const controlNumber = `${carrierCode ?? ""}${row.control_reference}`;
    const dupLine = seen.get(controlNumber);
    if (dupLine)
      errors.push({ column: "control_reference", message: `duplicate of line ${dupLine}` });
    else seen.set(controlNumber, line);
    if (existing.has(controlNumber))
      errors.push({ column: "control_reference", message: `${controlNumber} already exists` });

    const shipper = ref.partner(row.shipper_name);
    if (row.shipper_name && !shipper)
      errors.push({ column: "shipper_name", message: `no partner named "${row.shipper_name}"` });
    const consignee = ref.partner(row.consignee_name);
    if (row.consignee_name && !consignee)
      errors.push({
        column: "consignee_name",
        message: `no partner named "${row.consignee_name}"`,
      });
    const broker = ref.partner(row.broker_name);
    if (row.broker_name && !broker)
      errors.push({ column: "broker_name", message: `no partner named "${row.broker_name}"` });
    else if (broker && broker.type !== "broker" && broker.type !== "both")
      errors.push({ column: "broker_name", message: `"${row.broker_name}" is not a broker` });

    const portOr = (column: string, kind: string, code: string | undefined) => {
      if (!code) return null;
      const id = ref.port(row.regime, kind, code);
      if (!id)
        errors.push({
          column,
          message: `unknown ${row.regime} ${kind.replace(/_/g, " ")} code ${code}`,
        });
      return id ?? null;
    };
    const entryPortId = portOr(
      "entry_port",
      "port_of_entry",
      row.regime === "ACE" ? row.entry_port : undefined,
    );
    const inBondDestinationPortId = portOr(
      "in_bond_destination",
      "in_bond_destination",
      row.regime === "ACE" ? row.in_bond_destination : undefined,
    );
    const destinationPortId = portOr(
      "destination_port",
      "cbsa_office",
      row.regime === "ACI" ? row.destination_port : undefined,
    );
    const sublocationPortId = portOr(
      "sublocation",
      "sublocation",
      row.regime === "ACI" ? row.sublocation : undefined,
    );

    if (errors.length) {
      rows.push({ line, status: "error", errors, label: controlNumber });
      return;
    }
    rows.push({ line, status: "ok", errors: [], label: controlNumber });
    payload.push({
      regime: row.regime,
      carrierCode: carrierCode!,
      controlReference: row.control_reference,
      shipmentType: row.regime === "ACE" ? (row.shipment_type ?? null) : null,
      cargoType: row.regime === "ACI" ? (row.cargo_type ?? null) : null,
      shipperId: shipper?.id ?? null,
      consigneeId: consignee?.id ?? null,
      brokerId: broker?.id ?? null,
      entryPortId,
      inBondEntryType: row.in_bond_entry_type ?? null,
      inBondDestinationPortId,
      isPars: row.is_pars,
      destinationPortId,
      sublocationPortId,
      loadingCountry: row.loading_country ?? null,
      loadingProvince: row.loading_province ?? null,
      loadingCity: row.loading_city ?? null,
      consigneeBusinessNumber: row.consignee_business_number ?? null,
    });
  });
  const okCount = rows.filter((r) => r.status === "ok").length;
  return { report: { rows, okCount, errorCount: rows.length - okCount }, payload };
}

export async function validateCommodityRows(
  tx: RlsTransaction,
  orgId: string,
  raw: Record<string, string>[],
): Promise<{ report: ImportReport; payload: ResolvedCommodity[] }> {
  const controls = [
    ...new Set(raw.map((r) => (r.control_number ?? "").trim().toUpperCase()).filter(Boolean)),
  ];
  const targets = controls.length
    ? await tx
        .select({
          id: shipments.id,
          controlNumber: shipments.controlNumber,
          movementStatus: movements.status,
        })
        .from(shipments)
        .leftJoin(movements, eq(movements.id, shipments.movementId))
        .where(and(eq(shipments.organizationId, orgId), inArray(shipments.controlNumber, controls)))
    : [];
  const byControl = new Map(targets.map((t) => [t.controlNumber, t]));
  const rows: ImportReportRow[] = [];
  const payload: ResolvedCommodity[] = [];

  raw.forEach((r, i) => {
    const line = i + 2;
    const parsed = commodityImportRow.safeParse(r);
    if (!parsed.success) {
      rows.push({
        line,
        status: "error",
        errors: zodErrors(parsed.error.issues),
        label: r.control_number ?? "",
      });
      return;
    }
    const row: CommodityImportRow = parsed.data;
    const errors: ImportRowError[] = [];
    const target = byControl.get(row.control_number);
    if (!target)
      errors.push({ column: "control_number", message: `no shipment ${row.control_number}` });
    else if (target.movementStatus && !EDITABLE_MOVEMENT.has(target.movementStatus))
      errors.push({
        column: "control_number",
        message: `${row.control_number} is on a ${target.movementStatus} movement and cannot take new lines`,
      });
    const hazmat: ResolvedCommodity["hazmat"] = [];
    for (const n of [1, 2, 3] as const) {
      const code = row[`hazmat_code_${n}`];
      const desc = row[`hazmat_description_${n}`];
      if (!code && (desc || row[`hazmat_contact_${n}`] || row[`hazmat_phone_${n}`]))
        errors.push({
          column: `hazmat_code_${n}`,
          message: `hazmat ${n} has details but no UN code`,
        });
      if (code)
        hazmat.push({
          unCode: code,
          description: desc ?? null,
          emergencyContact: row[`hazmat_contact_${n}`] ?? null,
          emergencyPhone: row[`hazmat_phone_${n}`] ?? null,
        });
    }
    if (row.value_amount != null && !row.value_currency)
      errors.push({ column: "value_currency", message: "a value needs a currency" });
    const label = `${row.control_number} · ${row.description}`;
    if (errors.length) {
      rows.push({ line, status: "error", errors, label });
      return;
    }
    const weightUnit = row.weight_unit ?? "KG";
    rows.push({ line, status: "ok", errors: [], label });
    payload.push({
      shipmentId: target!.id,
      lineNumber: row.line_number ?? null,
      commodityDescription: row.description,
      hsCode: row.hs_code ?? null,
      quantity: row.quantity ?? null,
      quantityUnit: row.quantity_unit ?? null,
      weightKg:
        row.weight == null
          ? null
          : weightUnit === "LB"
            ? Math.round(row.weight * 0.45359237 * 100) / 100
            : row.weight,
      weightUnit,
      countryOfOrigin: row.country_of_origin ?? null,
      marksAndNumbers: row.marks_and_numbers ?? null,
      valueAmount: row.value_amount ?? null,
      valueCurrency: row.value_currency ?? null,
      isConsolidated: row.is_consolidated,
      hazmat,
    });
  });
  const okCount = rows.filter((r) => r.status === "ok").length;
  return { report: { rows, okCount, errorCount: rows.length - okCount }, payload };
}

/** Parse + validate + persist a `validated` batch. Nothing is inserted yet. */
export async function validateImport(
  tx: RlsTransaction,
  actor: Actor,
  input: { kind: ImportKind; filename: string; content: string },
) {
  const { rows: raw, columns } = parseCsv(input.content);
  const spec = IMPORT_TEMPLATES[input.kind];
  const known = new Set(spec.map((c) => c.key));
  const unknownColumns = columns.filter((c) => !known.has(c));
  const missing = spec.filter((c) => c.required && !columns.includes(c.key)).map((c) => c.key);
  if (missing.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Missing required column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    });
  if (raw.length === 0)
    throw new TRPCError({ code: "BAD_REQUEST", message: "The file has no data rows" });
  if (raw.length > 5000)
    throw new TRPCError({ code: "BAD_REQUEST", message: "At most 5,000 rows per file" });

  const { report, payload } =
    input.kind === "shipments"
      ? await validateShipmentRows(tx, actor.orgId, raw)
      : await validateCommodityRows(tx, actor.orgId, raw);

  const [batch] = await tx
    .insert(importBatches)
    .values({
      organizationId: actor.orgId,
      kind: input.kind,
      filename: input.filename,
      rowCount: raw.length,
      okCount: report.okCount,
      errorCount: report.errorCount,
      status: "validated",
      report: { rows: report.rows, unknownColumns, payload },
      createdBy: actor.userId,
    })
    .returning();
  return { batch: batch!, report, unknownColumns };
}

export async function requireBatch(tx: RlsTransaction, orgId: string, batchId: string) {
  const [b] = await tx
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.id, batchId), eq(importBatches.organizationId, orgId)))
    .limit(1);
  if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "Import batch not found" });
  return b;
}

const isUniqueViolation = (e: unknown) =>
  (e as { cause?: { code?: string }; code?: string })?.cause?.code === "23505" ||
  (e as { code?: string })?.code === "23505";

/** Insert every ok row of a validated batch in one transaction. */
export async function commitImport(tx: RlsTransaction, actor: Actor, batchId: string) {
  const batch = await requireBatch(tx, actor.orgId, batchId);
  if (batch.status !== "validated")
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Batch is already ${batch.status}`,
    });
  const report = batch.report as { payload?: unknown[] };
  const payload = report.payload ?? [];
  let inserted = 0;

  if (batch.kind === "shipments") {
    for (const p of payload as ResolvedShipment[]) {
      try {
        await tx.insert(shipments).values({
          organizationId: actor.orgId,
          regime: p.regime,
          carrierCode: p.carrierCode,
          controlReference: p.controlReference,
          shipmentType: p.shipmentType as typeof shipments.$inferInsert.shipmentType,
          cargoType: p.cargoType as typeof shipments.$inferInsert.cargoType,
          shipperId: p.shipperId,
          consigneeId: p.consigneeId,
          brokerId: p.brokerId,
          entryPortId: p.entryPortId,
          inBondEntryType: p.inBondEntryType,
          inBondDestinationPortId: p.inBondDestinationPortId,
          isPars: p.isPars,
          destinationPortId: p.destinationPortId,
          sublocationPortId: p.sublocationPortId,
          loadingCountry: p.loadingCountry,
          loadingProvince: p.loadingProvince,
          loadingCity: p.loadingCity,
          consigneeBusinessNumber: p.consigneeBusinessNumber,
          importBatchId: batch.id,
        });
      } catch (e) {
        if (isUniqueViolation(e))
          throw new TRPCError({
            code: "CONFLICT",
            message: `${p.carrierCode}${p.controlReference} was created since validation — validate the file again`,
          });
        throw e;
      }
      inserted += 1;
    }
  } else {
    const nextLine = new Map<string, number>();
    for (const p of payload as ResolvedCommodity[]) {
      let line = p.lineNumber;
      if (line == null) {
        if (!nextLine.has(p.shipmentId)) {
          const [max] = await tx
            .select({ n: sql<number>`coalesce(max(${commodities.lineNumber}), 0)` })
            .from(commodities)
            .where(eq(commodities.shipmentId, p.shipmentId));
          nextLine.set(p.shipmentId, Number(max?.n ?? 0));
        }
        line = nextLine.get(p.shipmentId)! + 1;
      }
      nextLine.set(p.shipmentId, Math.max(nextLine.get(p.shipmentId) ?? 0, line));
      const [row] = await tx
        .insert(commodities)
        .values({
          organizationId: actor.orgId,
          shipmentId: p.shipmentId,
          lineNumber: line,
          commodityDescription: p.commodityDescription,
          hsCode: p.hsCode,
          quantity: p.quantity,
          quantityUnit: p.quantityUnit,
          weightKg: p.weightKg,
          weightUnit: p.weightUnit,
          countryOfOrigin: p.countryOfOrigin,
          marksAndNumbers: p.marksAndNumbers,
          valueAmount: p.valueAmount,
          valueCurrency: p.valueCurrency,
          isConsolidated: p.isConsolidated,
          importBatchId: batch.id,
        })
        .returning({ id: commodities.id });
      if (p.hazmat.length) await writeHazmat(tx, actor.orgId, row!.id, p.hazmat);
      inserted += 1;
    }
  }

  const [updated] = await tx
    .update(importBatches)
    .set({ status: "committed", committedAt: new Date() })
    .where(eq(importBatches.id, batch.id))
    .returning();
  return { batch: updated!, inserted };
}

/**
 * Delete what a batch created while it is still a draft: shipments not yet
 * on a transmitted movement (their lines cascade), or commodity lines whose
 * shipment is still editable. Anything already filed stays and is reported.
 */
export async function deleteImportBatch(tx: RlsTransaction, actor: Actor, batchId: string) {
  const batch = await requireBatch(tx, actor.orgId, batchId);
  if (batch.status !== "committed")
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Only a committed batch can be deleted (this one is ${batch.status})`,
    });
  let deleted = 0;
  const kept: string[] = [];
  if (batch.kind === "shipments") {
    const rows = await tx
      .select({
        id: shipments.id,
        controlNumber: shipments.controlNumber,
        status: shipments.status,
        movementStatus: movements.status,
      })
      .from(shipments)
      .leftJoin(movements, eq(movements.id, shipments.movementId))
      .where(and(eq(shipments.importBatchId, batch.id), eq(shipments.organizationId, actor.orgId)));
    for (const r of rows) {
      const draft =
        r.status === "draft" && (!r.movementStatus || EDITABLE_MOVEMENT.has(r.movementStatus));
      if (!draft) {
        kept.push(r.controlNumber);
        continue;
      }
      await tx.delete(shipments).where(eq(shipments.id, r.id));
      deleted += 1;
    }
  } else {
    const rows = await tx
      .select({
        id: commodities.id,
        description: commodities.commodityDescription,
        movementStatus: movements.status,
      })
      .from(commodities)
      .innerJoin(shipments, eq(shipments.id, commodities.shipmentId))
      .leftJoin(movements, eq(movements.id, shipments.movementId))
      .where(
        and(eq(commodities.importBatchId, batch.id), eq(commodities.organizationId, actor.orgId)),
      );
    for (const r of rows) {
      if (r.movementStatus && !EDITABLE_MOVEMENT.has(r.movementStatus)) {
        kept.push(r.description);
        continue;
      }
      await tx.delete(commodities).where(eq(commodities.id, r.id));
      deleted += 1;
    }
  }
  const [updated] = await tx
    .update(importBatches)
    .set({
      status: "deleted",
      deletedAt: new Date(),
      report: { ...(batch.report as object), deleted, kept },
    })
    .where(eq(importBatches.id, batch.id))
    .returning();
  return { batch: updated!, deleted, kept };
}
