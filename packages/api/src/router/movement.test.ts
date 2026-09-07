/**
 * `movement.submit` / `movement.cancel` against a mocked database.
 *
 * The transaction is the in-memory fake from `../test/mock-context`, so the
 * real transmit path runs end to end — domain validation, the mock customs
 * gateway, the integration_events row, the state machine and the append-only
 * event timeline — while `writeAudit` and the risk sync (which has its own
 * coverage) are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionKey } from "@corridor/domain";
import type * as AuditModule from "../services/audit";
import type * as NotificationsModule from "../services/notifications";
import type * as RiskModule from "../services/risk";
import {
  TEST_ORG_ID,
  TEST_USER_ID,
  createMockCaller,
  statementText,
  type MockContextOptions,
  type Row,
} from "../test/mock-context";

const writeAudit = vi.fn();
vi.mock("../services/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof AuditModule>()),
  writeAudit: (...args: unknown[]) => writeAudit(...args),
}));

const syncMovementRiskAlerts = vi.fn();
vi.mock("../services/risk", async (importOriginal) => ({
  ...(await importOriginal<typeof RiskModule>()),
  syncMovementRiskAlerts: (...args: unknown[]) => syncMovementRiskAlerts(...args),
}));

// The `movement.assigned` delivery itself is covered end to end in
// notify-assigned.integration.test.ts; here we only prove the wiring.
const notifyDriverAssigned = vi.fn();
vi.mock("../services/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  notifyDriverAssigned: (...args: unknown[]) => notifyDriverAssigned(...args),
}));

const { movementRouter } = await import("./movement");
const { createCallerFactory } = await import("../trpc");
const createCaller = createCallerFactory(movementRouter);

const MOVEMENT_ID = "44444444-4444-4444-8444-444444444444";
const DRIVER_ID = "55555555-5555-4555-8555-555555555555";
const TRUCK_ID = "66666666-6666-4666-8666-666666666666";
const TRAILER_ID = "77777777-7777-4777-8777-777777777777";
const PARTNER_ID = "88888888-8888-4888-8888-888888888888";

const inDays = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};
const isoDay = (days: number) => inDays(days).toISOString().slice(0, 10);

function movementRow(over: Row = {}): Row {
  return {
    id: MOVEMENT_ID,
    organizationId: TEST_ORG_ID,
    regime: "ACE",
    movementNumber: "ACE-26-00042",
    tripNumber: "TRIP-1042",
    status: "draft",
    crossingPoint: { code: "3801", name: "Detroit" },
    scheduledCrossingAt: inDays(1),
    driverId: DRIVER_ID,
    truckId: TRUCK_ID,
    trailerId: TRAILER_ID,
    customsReferenceNumber: null,
    notes: null,
    createdBy: TEST_USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** Registries + one clean cargo line: everything `validateForTransmit` demands. */
function transmittableRows(movement: Row = movementRow()): Record<string, Row[]> {
  return {
    organizations: [
      {
        id: TEST_ORG_ID,
        name: "Corridor Test Carrier",
        scacCode: "CTCX",
        canadianCarrierCode: "CTC1",
        usDotNumber: "7654321",
      },
    ],
    movements: [movement],
    drivers: [
      {
        id: DRIVER_ID,
        organizationId: TEST_ORG_ID,
        firstName: "Gurpreet",
        lastName: "Singh",
        status: "active",
        licenseNumber: "S1234-56789-01234",
        licenseExpiry: isoDay(400),
        fastCardNumber: null,
        fastCardExpiry: null,
        citizenship: "CA",
      },
    ],
    trucks: [
      {
        id: TRUCK_ID,
        organizationId: TEST_ORG_ID,
        unitNumber: "T-101",
        status: "active",
        plateNumber: "AB12345",
        registrationExpiry: isoDay(300),
        insuranceExpiry: isoDay(200),
      },
    ],
    trailers: [
      {
        id: TRAILER_ID,
        organizationId: TEST_ORG_ID,
        unitNumber: "TR-501",
        status: "active",
        plateNumber: "TRL5011",
        registrationExpiry: isoDay(180),
      },
    ],
    cargo: [
      {
        id: "99999999-9999-4999-8999-999999999999",
        organizationId: TEST_ORG_ID,
        movementId: MOVEMENT_ID,
        lineNumber: 1,
        commodityDescription: "Hot-rolled steel coils",
        hsCode: "7208.39",
        weightKg: 18000,
        pieceCount: 6,
        shipperId: PARTNER_ID,
        consigneeId: PARTNER_ID,
        valueAmount: 42000,
        valueCurrency: "USD",
        countryOfOrigin: "CA",
      },
    ],
    seals: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        organizationId: TEST_ORG_ID,
        movementId: MOVEMENT_ID,
        sealNumber: "SL-100231",
      },
    ],
    integrationConfigs: [
      {
        organizationId: TEST_ORG_ID,
        provider: "cbp_ace",
        environment: "sandbox",
        status: "active",
        credentialsRef: null,
        settings: { mockDelayMs: 0, mockFailureRate: 0 },
      },
    ],
    movementEvents: [],
    movementAmendments: [],
    backgroundJobs: [],
    integrationEvents: [],
  };
}

const DISPATCHER: PermissionKey[] = [
  "movement.read",
  "movement.write",
  "movement.transmit_to_customs",
  "movement.cancel",
];

const caller = (options: MockContextOptions = {}) =>
  createMockCaller(createCaller, { permissions: DISPATCHER, ...options });

beforeEach(() => {
  writeAudit.mockReset();
  syncMovementRiskAlerts.mockReset().mockResolvedValue({ created: 0, resolved: 0 });
  notifyDriverAssigned.mockReset().mockResolvedValue({ notified: 0, emailed: 0, pushed: 0 });
});

describe("movement.update", () => {
  const rowsWithDriver = (driverId: string | null) => ({
    movements: [movementRow({ driverId })],
    drivers: [{ id: DRIVER_ID, organizationId: TEST_ORG_ID, userId: "driver-user" }],
  });

  it("notifies the driver when one is assigned", async () => {
    const { caller: api } = caller({ rows: rowsWithDriver(null) });
    await api.update({ id: MOVEMENT_ID, driverId: DRIVER_ID });

    expect(notifyDriverAssigned).toHaveBeenCalledTimes(1);
    expect(notifyDriverAssigned.mock.calls[0]![2]).toMatchObject({
      orgId: TEST_ORG_ID,
      driverId: DRIVER_ID,
      movementId: MOVEMENT_ID,
      movementNumber: "ACE-26-00042",
      actorUserId: TEST_USER_ID,
    });
  });

  it("stays quiet when the driver did not change", async () => {
    const { caller: api } = caller({ rows: rowsWithDriver(DRIVER_ID) });
    await api.update({ id: MOVEMENT_ID, driverId: DRIVER_ID });
    expect(notifyDriverAssigned).not.toHaveBeenCalled();
  });

  it("stays quiet for a patch that does not touch the driver", async () => {
    const { caller: api } = caller({ rows: rowsWithDriver(null) });
    await api.update({ id: MOVEMENT_ID, tripNumber: "TRIP-9" });
    expect(notifyDriverAssigned).not.toHaveBeenCalled();
  });

  it("stays quiet when the driver is unassigned", async () => {
    const { caller: api } = caller({ rows: rowsWithDriver(DRIVER_ID) });
    await api.update({ id: MOVEMENT_ID, driverId: null });
    expect(notifyDriverAssigned).not.toHaveBeenCalled();
  });
});

describe("movement.submit", () => {
  it("refuses to transmit a manifest that fails validation, and leaves it editable", async () => {
    const rows = transmittableRows();
    rows.cargo = [];
    rows.drivers = [];
    const { caller: api, db } = caller({ rows });

    await expect(api.submit({ id: MOVEMENT_ID })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: /Cannot transmit:.*Assign a driver.*shipment line/s,
    });

    expect(db.table("movements")[0]!.status).toBe("draft");
    expect(db.table("movementEvents")).toHaveLength(0);
    expect(db.table("integrationEvents")).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("transmits a valid manifest: sent, reference number, timeline event, decision job", async () => {
    const { caller: api, db } = caller({ rows: transmittableRows() });

    const result = await api.submit({ id: MOVEMENT_ID });

    expect(result.movement.status).toBe("sent");
    expect(result.referenceNumber).toMatch(/^ACE-/);
    expect(db.table("movements")[0]).toMatchObject({
      status: "sent",
      customsReferenceNumber: result.referenceNumber,
    });

    const events = db.table("movementEvents");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      movementId: MOVEMENT_ID,
      eventType: "status_change",
      fromStatus: "draft",
      toStatus: "sent",
      actorType: "user",
      actorId: TEST_USER_ID,
    });

    const [integrationEvent] = db.table("integrationEvents");
    expect(integrationEvent).toMatchObject({
      provider: "cbp_ace",
      operation: "transmit",
      success: true,
      statusCode: 200,
    });

    const [job] = db.table("backgroundJobs");
    expect(job).toMatchObject({ jobType: "customs.decide", organizationId: TEST_ORG_ID });
    expect((job!.payload as Row).movementId).toBe(MOVEMENT_ID);

    // Risk findings are refreshed against the final manifest before it leaves.
    expect(syncMovementRiskAlerts).toHaveBeenCalledWith(
      expect.anything(),
      TEST_ORG_ID,
      MOVEMENT_ID,
    );
  });

  it("audits the submit and meters the transmission", async () => {
    const { caller: api, db } = caller({ rows: transmittableRows() });

    const result = await api.submit({ id: MOVEMENT_ID });

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const [, orgId, action, entityType, entityId, before, after] = writeAudit.mock.calls[0]!;
    expect({ orgId, action, entityType, entityId, before }).toEqual({
      orgId: TEST_ORG_ID,
      action: "movement.submit",
      entityType: "movement",
      entityId: MOVEMENT_ID,
      before: { status: "draft" },
    });
    expect(after).toEqual({ status: "sent", referenceNumber: result.referenceNumber });

    expect(db.executed.map(statementText).join("\n")).toContain(
      `public.record_usage(\n      ${TEST_ORG_ID}::uuid, movements_transmitted, 1::int`,
    );
  });

  it("surfaces a gateway outage as BAD_GATEWAY, keeps the manifest editable, logs the failure", async () => {
    // The mock gateway fails deterministically on a trip number containing FAIL.
    const { caller: api, db } = caller({
      rows: transmittableRows(movementRow({ tripNumber: "TRIP-FAIL-1" })),
    });

    await expect(api.submit({ id: MOVEMENT_ID })).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: /try again shortly/,
    });

    expect(db.table("movements")[0]!.status).toBe("draft");
    expect(db.table("integrationEvents")[0]).toMatchObject({ success: false, statusCode: 503 });
    expect(db.table("backgroundJobs")).toHaveLength(0);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      TEST_ORG_ID,
      "movement.submit_failed",
      "movement",
      MOVEMENT_ID,
      null,
      { statusCode: 503, retryable: true, error: expect.stringContaining("unavailable") },
    );
  });

  it("requires movement.transmit_to_customs before touching the movement", async () => {
    const { caller: api, db } = caller({
      permissions: ["movement.read", "movement.write"],
      rows: transmittableRows(),
    });

    await expect(api.submit({ id: MOVEMENT_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Missing permission: movement.transmit_to_customs",
    });
    expect(db.table("movements")[0]!.status).toBe("draft");
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe("movement.cancel", () => {
  it("cancels a draft, records the reason on the event and in the audit log", async () => {
    const { caller: api, db } = caller({ rows: transmittableRows() });

    const row = await api.cancel({ id: MOVEMENT_ID, reason: "Customer cancelled the load" });

    expect(row.status).toBe("cancelled");
    expect(db.table("movements")[0]!.status).toBe("cancelled");
    expect(db.table("movementEvents")[0]).toMatchObject({
      eventType: "status_change",
      fromStatus: "draft",
      toStatus: "cancelled",
      payload: { reason: "Customer cancelled the load" },
    });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      TEST_ORG_ID,
      "movement.cancel",
      "movement",
      MOVEMENT_ID,
      { status: "draft" },
      { status: "cancelled", reason: "Customer cancelled the load" },
    );
  });

  it("refuses a transition the state machine does not allow", async () => {
    const { caller: api, db } = caller({
      rows: transmittableRows(movementRow({ status: "arrived" })),
    });

    await expect(api.cancel({ id: MOVEMENT_ID })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(db.table("movements")[0]!.status).toBe("arrived");
    expect(db.table("movementEvents")).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("is NOT_FOUND for a movement outside the caller's organization", async () => {
    const rows = transmittableRows();
    rows.movements = [];
    const { caller: api } = caller({ rows });

    await expect(api.cancel({ id: MOVEMENT_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Movement not found",
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("requires movement.cancel", async () => {
    const { caller: api } = caller({
      permissions: ["movement.read", "movement.write"],
      rows: transmittableRows(),
    });

    await expect(api.cancel({ id: MOVEMENT_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Missing permission: movement.cancel",
    });
  });
});
