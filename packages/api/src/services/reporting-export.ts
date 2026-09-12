/**
 * Tabular exports (Task 12): the same column/row shape goes to a CSV file or
 * to the PDF table template, and either lands in `generated_documents` so the
 * download is a signed URL like every other generated file.
 */
import { schema, type RlsTransaction } from "@corridor/db";
import type { ExportFormat } from "@corridor/domain";
import type { TableReportData } from "@corridor/pdf";
import type { Actor } from "./movements";
import { generatedPathFor, generateTableReport, signedUrlFor, uploadGeneratedFile } from "./pdf";

const { generatedDocuments } = schema;

export type ExportColumn = { key: string; label: string; width?: number };
export type ExportRow = Record<string, string | number | null>;

/** Leading characters that Excel / Sheets / LibreOffice interpret as a formula (OWASP CSV injection). */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * RFC 4180 quoting, plus formula-injection defence: a string that starts with
 * a formula trigger is prefixed with a single quote so spreadsheets render it
 * as text. Numbers pass through untouched (a negative number is data, not a
 * formula).
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s =
    typeof value === "number" ? String(value) : FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Whole file: UTF-8 BOM so Excel reads accents, CRLF line ends, header first. */
export function toCsv(columns: ExportColumn[], rows: ExportRow[]): string {
  const lines = [columns.map((c) => csvField(c.label)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvField(row[c.key])).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** Keep only the picked columns, in the picked order. */
export function pickColumns<K extends string>(
  all: ReadonlyArray<{ key: K; label: string }>,
  keys: readonly K[],
) {
  const byKey = new Map(all.map((c) => [c.key, c]));
  return keys.flatMap((k) => (byKey.has(k) ? [byKey.get(k)!] : []));
}

export async function exportTable(
  tx: RlsTransaction,
  actor: Actor,
  args: {
    kind: "report" | "registry_export";
    scope: string;
    format: ExportFormat;
    data: Omit<TableReportData, "carrier" | "generatedAt">;
    metadata?: Record<string, unknown>;
  },
) {
  const metadata = {
    ...(args.metadata ?? {}),
    format: args.format,
    rowCount: args.data.rows.length,
  };
  if (args.format === "pdf") {
    return generateTableReport(tx, actor, {
      kind: args.kind,
      scope: args.scope,
      data: args.data,
      metadata,
    });
  }
  const bytes = Buffer.from(toCsv(args.data.columns, args.data.rows), "utf8");
  const storagePath = generatedPathFor(actor.orgId, args.scope, args.kind).replace(
    /\.pdf$/,
    ".csv",
  );
  await uploadGeneratedFile(storagePath, bytes, "text/csv");
  const [row] = await tx
    .insert(generatedDocuments)
    .values({
      organizationId: actor.orgId,
      movementId: null,
      kind: args.kind,
      storagePath,
      contentType: "text/csv",
      byteSize: bytes.length,
      metadata,
      createdBy: actor.userId,
    })
    .returning();
  return {
    id: row!.id,
    storagePath,
    byteSize: bytes.length,
    signedUrl: await signedUrlFor(storagePath),
  };
}
