/**
 * `shipment.setLoadedOn` against a mocked database. The actual invariant
 * (same-movement, tenant-safe, clears on detach) is enforced by
 * shipments_loaded_on_guard() and proven against a real Postgres in
 * shipments-loaded-on.integration.test.ts; this file proves the procedure
 * turns a bad request into a clear tRPC error and writes an audit row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionKey } from "@corridor/domain";
import type * as AuditModule from "../services/audit";
import {
  TEST_ORG_ID,
  createMockCaller,
  type MockContextOptions,
  type Row,
} from "../test/mock-context";

const writeAudit = vi.fn();
vi.mock("../services/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof AuditModule>()),
  writeAudit: (...args: unknown[]) => writeAudit(...args),
}));

const { shipmentRouter } = await import("./shipment");
const { createCallerFactory } = await import("../trpc");
const createCaller = createCallerFactory(shipmentRouter);

const MOVEMENT_ID = "44444444-4444-4444-8444-444444444444";
const SHIPMENT_ID = "12121212-1212-4212-8212-121212121212";
const SLOT_ID = "13131313-1313-4313-8313-131313131313";

function movementRow(over: Row = {}): Row {
  return {
    id: MOVEMENT_ID,
    organizationId: TEST_ORG_ID,
    regime: "ACE",
    movementNumber: "ACE-26-00042",
    status: "draft",
    ...over,
  };
}

function shipmentRow(over: Row = {}): Row {
  return {
    id: SHIPMENT_ID,
    organizationId: TEST_ORG_ID,
    regime: "ACE",
    movementId: MOVEMENT_ID,
    status: "draft",
    loadedOnType: null,
    loadedOnMovementTrailerId: null,
    ...over,
  };
}

const WRITE: PermissionKey[] = ["shipment.write"];

const caller = (options: MockContextOptions = {}) =>
  createMockCaller(createCaller, { permissions: WRITE, ...options });

beforeEach(() => {
  writeAudit.mockReset();
});

describe("shipment.setLoadedOn", () => {
  it("rejects a shipment that has not been assigned to a movement yet", async () => {
    const { caller: c } = caller({
      rows: { shipments: [shipmentRow({ movementId: null })], movements: [] },
    });
    await expect(
      c.setLoadedOn({ id: SHIPMENT_ID, loadedOn: { type: "TRUCK" } }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Assign the shipment to a movement"),
    });
  });

  it("rejects once the movement is frozen (not draft/rejected)", async () => {
    const { caller: c } = caller({
      rows: {
        shipments: [shipmentRow()],
        movements: [movementRow({ status: "sent" })],
      },
    });
    await expect(
      c.setLoadedOn({ id: SHIPMENT_ID, loadedOn: { type: "TRUCK" } }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("rejects a trailer id that is not a slot on this trip", async () => {
    const { caller: c } = caller({
      rows: {
        shipments: [shipmentRow()],
        movements: [movementRow()],
        movementTrailers: [], // no slot exists at all
      },
    });
    await expect(
      c.setLoadedOn({
        id: SHIPMENT_ID,
        loadedOn: { type: "TRAILER", movementTrailerId: SLOT_ID },
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("not on this shipment's movement"),
    });
  });

  it("accepts an explicit TRUCK and writes an audit row", async () => {
    const { caller: c, db } = caller({
      rows: { shipments: [shipmentRow()], movements: [movementRow()] },
    });
    const row = await c.setLoadedOn({ id: SHIPMENT_ID, loadedOn: { type: "TRUCK" } });
    expect(row.loadedOnType).toBe("TRUCK");
    expect(row.loadedOnMovementTrailerId).toBeNull();
    expect(writeAudit).toHaveBeenCalledWith(
      db.tx,
      TEST_ORG_ID,
      "shipment.set_loaded_on",
      "shipment",
      SHIPMENT_ID,
      expect.objectContaining({ id: SHIPMENT_ID }),
      expect.objectContaining({ loadedOnType: "TRUCK" }),
    );
  });

  it("accepts a valid trailer slot on this movement", async () => {
    const { caller: c } = caller({
      rows: {
        shipments: [shipmentRow()],
        movements: [movementRow()],
        movementTrailers: [{ id: SLOT_ID, organizationId: TEST_ORG_ID, movementId: MOVEMENT_ID }],
      },
    });
    const row = await c.setLoadedOn({
      id: SHIPMENT_ID,
      loadedOn: { type: "TRAILER", movementTrailerId: SLOT_ID },
    });
    expect(row.loadedOnType).toBe("TRAILER");
    expect(row.loadedOnMovementTrailerId).toBe(SLOT_ID);
  });

  it("clears the placement when loadedOn is null", async () => {
    const { caller: c } = caller({
      rows: {
        shipments: [shipmentRow({ loadedOnType: "TRUCK" })],
        movements: [movementRow()],
      },
    });
    const row = await c.setLoadedOn({ id: SHIPMENT_ID, loadedOn: null });
    expect(row.loadedOnType).toBeNull();
    expect(row.loadedOnMovementTrailerId).toBeNull();
  });
});
