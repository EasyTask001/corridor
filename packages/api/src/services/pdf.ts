/**
 * Printable documents (0024): render with @corridor/pdf from `loadFull` + the
 * organization, upload to the private `documents` bucket under
 * <org>/generated/…, record a generated_documents row and hand back a short
 * signed URL. Server-only — the renderer never runs in a browser.
 */
import { createClient } from "@supabase/supabase-js";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, schema, type RlsTransaction } from "@corridor/db";
import {
  ACI_FLAG_KEYS,
  ACI_FLAG_LABELS,
  DRIVER_DOCUMENT_LABELS,
  type BlankDriverSheetsInput,
  type GeneratedDocumentKind,
} from "@corridor/domain";
import {
  renderBlankDriverSheets,
  renderDriverSheet,
  renderManifestSummary,
  renderTableReport,
  type DriverSheetData,
  type SheetCarrier,
  type TableReportData,
} from "@corridor/pdf";
import { DOCUMENTS_BUCKET } from "./documents";
import { loadFull, loadOrganization, type Actor, type FullMovement } from "./movements";

const { generatedDocuments, movementEvents } = schema;

/** Signed URLs live this long — enough to open or download, not to share. */
export const SIGNED_URL_SECONDS = 60;

/**
 * Unique per render: the worker (driver.notify) and a dispatcher pressing
 * "Print" can render the same sheet in the same second, so the stamp carries
 * milliseconds and a short random suffix.
 */
export function generatedPathFor(orgId: string, scope: string, kind: string, at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace("Z", "");
  const nonce = Math.random().toString(36).slice(2, 6);
  return `${orgId}/generated/${scope}/${kind}-${stamp}-${nonce}.pdf`;
}

/**
 * Service-role storage client. The bucket's object policies key off
 * `document.upload`, which a dispatcher printing a sheet need not hold; the
 * tRPC permission check (movement.read / report.read) is the gate, and the
 * object path is always under the caller's own organization.
 */
function adminStorage() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required to store PDFs",
    });
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    .storage;
}

/** Put a generated file (PDF or CSV) into the documents bucket. */
export async function uploadGeneratedFile(storagePath: string, bytes: Buffer, contentType: string) {
  const { error } = await adminStorage()
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath, bytes, { contentType, upsert: false });
  if (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Upload failed: ${error.message}`,
    });
  }
}

export async function signedUrlFor(storagePath: string, seconds = SIGNED_URL_SECONDS) {
  const { data, error } = await adminStorage()
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(storagePath, seconds);
  if (error || !data?.signedUrl) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not sign the PDF URL" });
  }
  return data.signedUrl;
}

async function storePdf(
  tx: RlsTransaction,
  actor: Actor,
  args: {
    movementId: string | null;
    kind: GeneratedDocumentKind;
    scope: string;
    bytes: Buffer;
    metadata: Record<string, unknown>;
  },
) {
  const storagePath = generatedPathFor(actor.orgId, args.scope, args.kind);
  const { error } = await adminStorage()
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath, args.bytes, { contentType: "application/pdf", upsert: false });
  if (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `PDF upload failed: ${error.message}`,
    });
  }
  const [row] = await tx
    .insert(generatedDocuments)
    .values({
      organizationId: actor.orgId,
      movementId: args.movementId,
      kind: args.kind,
      storagePath,
      contentType: "application/pdf",
      byteSize: args.bytes.length,
      metadata: args.metadata,
      createdBy: actor.userId,
    })
    .returning();
  return {
    id: row!.id,
    storagePath,
    byteSize: args.bytes.length,
    signedUrl: await signedUrlFor(storagePath),
  };
}

function carrierOf(
  org: Awaited<ReturnType<typeof loadOrganization>>,
  carrierCode: string | null,
): SheetCarrier {
  return {
    name: org.name,
    legalName: org.legalName,
    carrierCode,
    usDotNumber: org.usDotNumber,
    filerCode: org.filerCode,
  };
}

/** The sheet's view of a movement: registry rows folded into printable strings. */
export async function driverSheetDataFor(
  tx: RlsTransaction,
  org: Awaited<ReturnType<typeof loadOrganization>>,
  full: FullMovement,
  simple: boolean,
): Promise<DriverSheetData> {
  const customsRows = await tx
    .select({ payload: movementEvents.payload, occurredAt: movementEvents.occurredAt })
    .from(movementEvents)
    .where(
      and(eq(movementEvents.movementId, full.id), eq(movementEvents.eventType, "customs_event")),
    )
    .orderBy(asc(movementEvents.occurredAt));
  const plates = (
    primary: string,
    jurisdiction: string,
    extra: Array<{ plateNumber: string; jurisdiction: string }>,
  ) => [`${primary} ${jurisdiction}`, ...extra.map((p) => `${p.plateNumber} ${p.jurisdiction}`)];
  return {
    carrier: carrierOf(org, full.carrierCode),
    trip: {
      regime: full.regime,
      movementNumber: full.movementNumber,
      tripNumber: full.tripNumber,
      status: full.status,
      portCode: full.port?.code ?? null,
      portName: full.port?.name ?? null,
      scheduledCrossingAt: full.scheduledCrossingAt?.toISOString() ?? null,
      customsReferenceNumber: full.customsReferenceNumber,
      isEmpty: full.isEmpty,
      iitIndicator: full.iitIndicator,
      aciFlags: ACI_FLAG_KEYS.filter((k) => full[k]).map((k) => ACI_FLAG_LABELS[k]),
    },
    crew: full.crew.map((c) => ({
      role: c.role,
      name: `${c.firstName} ${c.lastName}`,
      personType: c.personType,
      licenseNumber: c.licenseNumber,
      licenseJurisdiction: c.licenseJurisdiction,
      citizenship: c.citizenship,
      documents: c.documents.map((d) => ({
        type: DRIVER_DOCUMENT_LABELS[d.documentType],
        number: d.documentNumber,
        expiresOn: d.expiresOn,
      })),
    })),
    truck: full.truck
      ? {
          unitNumber: full.truck.unitNumber,
          vin: full.truck.vin,
          plates: plates(full.truck.plateNumber, full.truck.plateJurisdiction, full.truck.plates),
          seals: full.seals.filter((s) => !s.movementTrailerId).map((s) => s.sealNumber),
        }
      : null,
    trailers: full.trailers.map((t) => ({
      unitNumber: t.unitNumber,
      type: t.trailerType,
      vin: t.vin,
      plates: plates(t.plateNumber, t.plateJurisdiction, t.plates),
      seals: t.seals.map((s) => s.sealNumber),
    })),
    shipments: full.shipments.map((s) => ({
      controlNumber: s.controlNumber,
      kind: s.shipmentType ?? s.cargoType,
      entryNumber: s.entryNumber,
      entryPortCode: s.entryPortCode,
      status: s.status,
      shipper: s.shipperName,
      consignee: s.consigneeName,
      inBond: s.inBondEntryType
        ? `${s.inBondEntryType}${s.inBondNumber ? ` ${s.inBondNumber}` : ""}${s.inBondDestinationPortCode ? ` → ${s.inBondDestinationPortCode}` : ""}`
        : null,
      commodities: s.commodities.map((c) => ({
        line: c.lineNumber,
        description: c.commodityDescription,
        hsCode: c.hsCode,
        quantity: c.quantity,
        quantityUnit: c.quantityUnit,
        weightKg: c.weightKg,
        countryOfOrigin: c.countryOfOrigin,
        hazmat: c.hazmat.map((h) => h.unCode),
      })),
    })),
    customsEvents: customsRows.map((e) => {
      const p = e.payload ?? {};
      const detail = [
        p.shipmentControlNumber,
        p.entryNumber && `entry ${p.entryNumber}`,
        p.entryPortCode && `@ ${p.entryPortCode}`,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        label: String(p.label ?? p.code ?? ""),
        occurredAt: e.occurredAt.toISOString(),
        detail: detail || null,
      };
    }),
    generatedAt: new Date().toISOString(),
    simple,
  };
}

/** Render + store one movement document. */
export async function generateForMovement(
  tx: RlsTransaction,
  actor: Actor,
  input: { movementId: string; kind: "driver_sheet" | "manifest_summary" },
) {
  const full = await loadFull(tx, actor.orgId, input.movementId);
  const org = await loadOrganization(tx, actor.orgId);
  const data = await driverSheetDataFor(tx, org, full, org.simpleDriverSheet);
  const bytes =
    input.kind === "driver_sheet"
      ? await renderDriverSheet(data)
      : await renderManifestSummary(data);
  return storePdf(tx, actor, {
    movementId: full.id,
    kind: input.kind,
    scope: full.id,
    bytes,
    metadata: { movementNumber: full.movementNumber, status: full.status, simple: data.simple },
  });
}

/** Render + store a batch of pre-numbered blank sheets. */
export async function generateBlankSheets(
  tx: RlsTransaction,
  actor: Actor,
  input: BlankDriverSheetsInput,
) {
  const org = await loadOrganization(tx, actor.orgId);
  const carrierCode = input.regime === "ACE" ? org.scacCode : org.canadianCarrierCode;
  const tripNumbers = Array.from(
    { length: input.toTrip - input.fromTrip + 1 },
    (_, i) => `${input.prefix}${input.fromTrip + i}`,
  );
  const bytes = await renderBlankDriverSheets({
    carrier: carrierOf(org, carrierCode),
    regime: input.regime,
    tripNumbers,
    driverName: input.driverName ?? null,
    coDriverName: input.coDriverName ?? null,
    generatedAt: new Date().toISOString(),
  });
  return storePdf(tx, actor, {
    movementId: null,
    kind: "blank_driver_sheet",
    scope: "blank",
    bytes,
    metadata: {
      regime: input.regime,
      prefix: input.prefix,
      fromTrip: input.fromTrip,
      toTrip: input.toTrip,
      pages: tripNumbers.length,
    },
  });
}

/** Render + store a table report (Task 12 uses this for exports). */
export async function generateTableReport(
  tx: RlsTransaction,
  actor: Actor,
  input: {
    kind: "report" | "registry_export";
    scope: string;
    data: Omit<TableReportData, "carrier" | "generatedAt">;
    metadata?: Record<string, unknown>;
  },
) {
  const org = await loadOrganization(tx, actor.orgId);
  const bytes = await renderTableReport({
    ...input.data,
    carrier: carrierOf(org, org.scacCode),
    generatedAt: new Date().toISOString(),
  });
  return storePdf(tx, actor, {
    movementId: null,
    kind: input.kind,
    scope: input.scope,
    bytes,
    metadata: input.metadata ?? {},
  });
}

export async function requireGeneratedDocument(tx: RlsTransaction, orgId: string, id: string) {
  const [doc] = await tx
    .select()
    .from(generatedDocuments)
    .where(and(eq(generatedDocuments.id, id), eq(generatedDocuments.organizationId, orgId)))
    .limit(1);
  if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
  return doc;
}
