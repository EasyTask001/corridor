/**
 * `documents.applyExtraction` — the human-in-the-loop step that turns a
 * reviewed AI extraction into cargo lines. What matters here is that AI output
 * only reaches `cargo` through a reviewer, that the document and movement
 * guards hold, and that applying resolves the low-confidence alert.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionKey } from "@corridor/domain";
import type * as AuditModule from "../services/audit";
import { TEST_ORG_ID, TEST_USER_ID, createMockCaller, type Row } from "../test/mock-context";

const writeAudit = vi.fn();
vi.mock("../services/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof AuditModule>()),
  writeAudit: (...args: unknown[]) => writeAudit(...args),
}));

const { documentsRouter } = await import("./documents");
const { createCallerFactory } = await import("../trpc");
const createCaller = createCallerFactory(documentsRouter);

const DOCUMENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MOVEMENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SHIPPER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CONSIGNEE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const documentRow = (over: Row = {}): Row => ({
  id: DOCUMENT_ID,
  organizationId: TEST_ORG_ID,
  movementId: null,
  documentType: "bol",
  storagePath: `${TEST_ORG_ID}/${DOCUMENT_ID}/bol-steel-coils.pdf`,
  originalFilename: "bol-steel-coils.pdf",
  mimeType: "application/pdf",
  sizeBytes: 24_000,
  uploadStatus: "extracted",
  extractionConfidence: 0.42,
  ...over,
});

const movementRow = (over: Row = {}): Row => ({
  id: MOVEMENT_ID,
  organizationId: TEST_ORG_ID,
  regime: "ACE",
  movementNumber: "ACE-26-00042",
  status: "draft",
  ...over,
});

/** Two reviewer-confirmed lines, in the same shape the review UI submits. */
const LINES = [
  {
    commodityDescription: "Hot-rolled steel coils",
    hsCode: "7208.39",
    weightKg: 18000,
    pieceCount: 6,
    valueAmount: 42000,
    valueCurrency: "USD" as const,
    countryOfOrigin: "CA",
    extractionConfidence: 0.91,
  },
  {
    commodityDescription: "Galvanized sheet, coils",
    hsCode: "7210.49",
    weightKg: 4000,
    pieceCount: 3,
  },
];

const lowConfidenceAlert = (): Row => ({
  id: "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationId: TEST_ORG_ID,
  alertType: "missing_data",
  source: "ai",
  status: "open",
  dedupeKey: `document:${DOCUMENT_ID}:low_confidence`,
  resolvedBy: null,
  resolvedAt: null,
});

function caller(
  over: {
    documents?: Row[];
    movements?: Row[];
    cargo?: Row[];
    alerts?: Row[];
    nextLine?: number;
    permissions?: PermissionKey[];
  } = {},
) {
  return createMockCaller(createCaller, {
    permissions: over.permissions ?? ["document.read", "document.review_extraction"],
    rows: {
      sourceDocuments: over.documents ?? [documentRow()],
      movements: over.movements ?? [movementRow()],
      cargo: over.cargo ?? [],
      complianceAlerts: over.alerts ?? [lowConfidenceAlert()],
      movementEvents: [],
    },
    sqlValues: { next: over.nextLine ?? 1 },
  });
}

const applyInput = (over: Record<string, unknown> = {}) => ({
  documentId: DOCUMENT_ID,
  movementId: MOVEMENT_ID,
  shipperId: SHIPPER_ID,
  consigneeId: CONSIGNEE_ID,
  lines: LINES,
  mode: "append" as const,
  ...over,
});

beforeEach(() => writeAudit.mockReset());

describe("documents.applyExtraction", () => {
  it("creates one cargo line per reviewed line, numbered after the existing ones", async () => {
    const { caller: api, db } = caller({ nextLine: 3 });

    const result = await api.applyExtraction(applyInput());

    expect(result).toEqual({ movementId: MOVEMENT_ID, inserted: 2 });
    const cargo = db.table("cargo");
    expect(cargo).toHaveLength(2);
    expect(cargo[0]).toMatchObject({
      movementId: MOVEMENT_ID,
      organizationId: TEST_ORG_ID,
      lineNumber: 3,
      commodityDescription: "Hot-rolled steel coils",
      hsCode: "7208.39",
      weightKg: 18000,
      pieceCount: 6,
      shipperId: SHIPPER_ID,
      consigneeId: CONSIGNEE_ID,
      sourceDocumentId: DOCUMENT_ID,
      extractionConfidence: 0.91,
    });
    expect(cargo[1]).toMatchObject({
      lineNumber: 4,
      commodityDescription: "Galvanized sheet, coils",
    });
    // Fields the reviewer left blank are stored as null, never undefined.
    expect(cargo[1]!.valueCurrency).toBeNull();
  });

  it("marks the document applied, notes it on the timeline and audits the apply", async () => {
    const { caller: api, db } = caller();

    await api.applyExtraction(applyInput());

    expect(db.table("sourceDocuments")[0]).toMatchObject({
      uploadStatus: "applied",
      appliedMovementId: MOVEMENT_ID,
      reviewedBy: TEST_USER_ID,
    });
    expect(db.table("movementEvents")[0]).toMatchObject({
      movementId: MOVEMENT_ID,
      eventType: "note",
      actorType: "user",
      payload: {
        body: expect.stringContaining("Applied 2 shipment line(s) from bol-steel-coils.pdf"),
        documentId: DOCUMENT_ID,
      },
    });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      TEST_ORG_ID,
      "document.apply_extraction",
      "source_document",
      DOCUMENT_ID,
      { status: "extracted", movementId: null },
      { status: "applied", movementId: MOVEMENT_ID, insertedLines: 2, mode: "append" },
    );
  });

  it("resolves the AI low-confidence alert once a reviewer has confirmed the data", async () => {
    const { caller: api, db } = caller();

    await api.applyExtraction(applyInput());

    expect(db.table("complianceAlerts")[0]).toMatchObject({
      status: "resolved",
      resolvedBy: TEST_USER_ID,
    });
  });

  it("replaces the existing lines when the reviewer chose replace", async () => {
    const { caller: api, db } = caller({
      cargo: [{ id: "old", movementId: MOVEMENT_ID, lineNumber: 1, commodityDescription: "Stale" }],
    });

    await api.applyExtraction(applyInput({ mode: "replace" }));

    const cargo = db.table("cargo");
    expect(cargo).toHaveLength(2);
    expect(cargo.map((c) => c.commodityDescription)).not.toContain("Stale");
  });

  it("refuses a document that has not been extracted yet", async () => {
    const { caller: api, db } = caller({ documents: [documentRow({ uploadStatus: "failed" })] });

    await expect(api.applyExtraction(applyInput())).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Document has not been extracted yet",
    });
    expect(db.table("cargo")).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("refuses to write cargo onto a manifest that is no longer editable", async () => {
    const { caller: api, db } = caller({ movements: [movementRow({ status: "sent" })] });

    await expect(api.applyExtraction(applyInput())).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Movement cannot be edited while sent",
    });
    expect(db.table("cargo")).toHaveLength(0);
    expect(db.table("sourceDocuments")[0]!.uploadStatus).toBe("extracted");
  });

  it("is NOT_FOUND when the document is not the caller organization's", async () => {
    const { caller: api } = caller({ documents: [] });

    await expect(api.applyExtraction(applyInput())).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Document not found",
    });
  });

  it("requires document.review_extraction — reading documents is not enough", async () => {
    const { caller: api, db } = caller({ permissions: ["document.read", "document.upload"] });

    await expect(api.applyExtraction(applyInput())).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Missing permission: document.review_extraction",
    });
    expect(db.table("cargo")).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
