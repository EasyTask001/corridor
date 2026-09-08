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
// notifications.integration.test.ts; here we only prove the wiring and, more
// importantly, that delivery happens *after* the transaction commits.
const resolveDriverAssignment = vi.fn();
const notifyUser = vi.fn();
vi.mock("../services/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  resolveDriverAssignment: (...args: unknown[]) => resolveDriverAssignment(...args),
  notifyUser: (...args: unknown[]) => notifyUser(...args),
}));

const { movementRouter } = await import("./movement");
const { createCallerFactory } = await import("../trpc");
const createCaller = createCallerFactory(movementRouter);

const MOVEMENT_ID = "44444444-4444-4444-8444-444444444444";
const DRIVER_ID = "55555555-5555-4555-8555-555555555555";
const TRUCK_ID = "66666666-6666-4666-8666-666666666666";
const TRAILER_ID = "77777777-7777-4777-8777-777777777777";
const PARTNER_ID = "88888888-8888-4888-8888-888888888888";
const PORT_ID = "99999999-9999-4999-8999-999999999998";
const SHIPMENT_ID = "12121212-1212-4212-8212-121212121212";
const SLOT_ID = "13131313-1313-4313-8313-131313131313";

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
    portId: PORT_ID,
    carrierCode: "PFTR",
    scheduledCrossingAt: inDays(1),
    truckId: TRUCK_ID,
    isEmpty: false,
    customsReferenceNumber: null,
    notes: null,
    createdBy: TEST_USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** Registries + one clean shipment: everything `validateForTransmit` demands. */
function transmittableRows(movement: Row = movementRow()): Record<string, Row[]> {
  return {
    organizations: [
      {
        id: TEST_ORG_ID,
        name: "Corridor Test Carrier",
        scacCode: "CTCX",
        canadianCarrierCode: "CTC1",
        usDotNumber: "7654321",
        filerCode: "F01",
      },
    ],
    movements: [movement],
    ports: [
      {
        id: PORT_ID,
        regime: "ACE",
        kind: "port_of_entry",
        code: "3801",
        name: "Detroit",
        country: "US",
      },
    ],
    // crewForMovement() joins movement_crew to drivers; the fake DB ignores
    // joins and projects from the driving table, so the person's fields sit on
    // the crew row here.
    movementCrew: [
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        organizationId: TEST_ORG_ID,
        movementId: MOVEMENT_ID,
        driverId: DRIVER_ID,
        role: "person_in_charge",
        position: 1,
        firstName: "Gurpreet",
        lastName: "Singh",
        status: "active",
        personType: "driver",
        gender: "M",
        licenseNumber: "S1234-56789-01234",
        licenseJurisdiction: "ON",
        licenseExpiry: isoDay(400),
        citizenship: "CA",
        hazmatEndorsement: false,
        usAddress: {},
      },
    ],
    drivers: [{ id: DRIVER_ID, organizationId: TEST_ORG_ID }],
    driverDocuments: [],
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
    // trailersForMovement() joins movement_trailers to trailers; as with the
    // crew, the fake DB projects from the driving table, so the trailer's
    // fields sit on the slot row.
    movementTrailers: [
      {
        id: SLOT_ID,
        organizationId: TEST_ORG_ID,
        movementId: MOVEMENT_ID,
        trailerId: TRAILER_ID,
        position: 1,
        unitNumber: "TR-501",
        trailerType: "TF",
        status: "active",
        plateNumber: "TRL5011",
        plateJurisdiction: "ON",
        registrationExpiry: isoDay(180),
      },
    ],
    equipmentPlates: [],
    shipments: [
      {
        id: SHIPMENT_ID,
        organizationId: TEST_ORG_ID,
        regime: "ACE",
        movementId: MOVEMENT_ID,
        carrierCode: "CTCX",
        shipmentType: "regular_bill",
        cargoType: null,
        controlReference: "PAPS90210",
        controlNumber: "CTCXPAPS90210",
        status: "draft",
        entryNumber: null,
        entryPortId: null,
        inBondEntryType: null,
        inBondDestinationPortId: null,
        inBondNumber: null,
        shipperId: PARTNER_ID,
        consigneeId: PARTNER_ID,
      },
    ],
    commodities: [
      {
        id: "99999999-9999-4999-8999-999999999999",
        organizationId: TEST_ORG_ID,
        shipmentId: SHIPMENT_ID,
        lineNumber: 1,
        commodityDescription: "Hot-rolled steel coils",
        hsCode: "7208.39",
        weightKg: 18000,
        weightUnit: "KG",
        quantity: 6,
        quantityUnit: "Coil",
        marksAndNumbers: null,
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
        movementTrailerId: SLOT_ID,
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

/** shipmentsForMovement() reads the party names/addresses through correlated
 * subqueries the fake DB cannot evaluate, so they come from `sqlValues`. */
const SHIPMENT_SQL_VALUES = {
  shipperName: "Maple Ridge Steel Ltd",
  shipperCountry: "CA",
  shipperAddress: { city: "Hamilton", country: "CA" },
  consigneeName: "Great Lakes Fabrication Inc",
  consigneeCountry: "US",
  consigneeAddress: { city: "Detroit", country: "US" },
  entryPortCode: null,
  inBondDestinationPortCode: null,
};

const caller = (options: MockContextOptions = {}) =>
  createMockCaller(createCaller, {
    permissions: DISPATCHER,
    ...options,
    sqlValues: { ...SHIPMENT_SQL_VALUES, ...options.sqlValues },
  });

beforeEach(() => {
  writeAudit.mockReset();
  syncMovementRiskAlerts.mockReset().mockResolvedValue({ created: 0, resolved: 0 });
  resolveDriverAssignment.mockReset().mockResolvedValue(null);
  notifyUser.mockReset().mockResolvedValue({ notified: 1, emailed: 0, pushed: 0 });
});

describe("movement.crew.add", () => {
  const ASSIGNMENT = {
    orgId: TEST_ORG_ID,
    userId: "driver-user",
    eventType: "movement.assigned" as const,
    title: "You are on ACE-26-00042",
  };
  const crewRows = (): Record<string, Row[]> => ({
    movements: [movementRow()],
    movementCrew: [],
    drivers: [{ id: DRIVER_ID, organizationId: TEST_ORG_ID, userId: "driver-user" }],
  });
  const add = { movementId: MOVEMENT_ID, driverId: DRIVER_ID, role: "crew_member" as const };

  it("resolves the assignment inside the transaction when somebody joins the crew", async () => {
    const { caller: api } = caller({ rows: crewRows() });
    await api.crew.add(add);

    expect(resolveDriverAssignment).toHaveBeenCalledTimes(1);
    expect(resolveDriverAssignment.mock.calls[0]![1]).toMatchObject({
      orgId: TEST_ORG_ID,
      driverId: DRIVER_ID,
      movementId: MOVEMENT_ID,
      movementNumber: "ACE-26-00042",
      actorUserId: TEST_USER_ID,
    });
  });

  /**
   * The reason the two halves are split: delivery needs a service-role
   * connection, and taking one while the caller's RLS transaction is still open
   * holds two connections from the same pool per request.
   */
  it("delivers only after the caller's transaction has committed", async () => {
    const order: string[] = [];
    resolveDriverAssignment.mockImplementation(async () => {
      order.push("resolve");
      return ASSIGNMENT;
    });
    notifyUser.mockImplementation(async () => {
      order.push("notify");
      return { notified: 1, emailed: 0, pushed: 0 };
    });
    const { caller: api } = caller({ rows: crewRows(), onCommit: () => order.push("commit") });

    await api.crew.add(add);

    expect(order).toEqual(["resolve", "commit", "notify"]);
    expect(notifyUser).toHaveBeenCalledWith(expect.anything(), ASSIGNMENT);
  });

  /**
   * The assignment is already durably committed by the time delivery is
   * attempted, so a notification failure must never surface as a failed
   * mutation — the dispatcher would retry an edit that already succeeded.
   */
  it("still returns the committed row when delivery fails, and logs it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      resolveDriverAssignment.mockResolvedValue(ASSIGNMENT);
      notifyUser.mockRejectedValue(new Error("expo is down"));
      const { caller: api, db } = caller({ rows: crewRows() });

      const row = await api.crew.add(add);

      expect(row).toMatchObject({ movementId: MOVEMENT_ID, driverId: DRIVER_ID });
      // The write really did land, not just the return value.
      expect(db.table("movementCrew")[0]).toMatchObject({ driverId: DRIVER_ID });
      expect(logged).toHaveBeenCalledTimes(1);
      const [message, error] = logged.mock.calls[0]!;
      expect(String(message)).toContain(MOVEMENT_ID);
      expect(String(message)).toContain(DRIVER_ID);
      expect(error).toBeInstanceOf(Error);
    } finally {
      logged.mockRestore();
    }
  });

  it("sends nothing when the assignment resolves to no recipient", async () => {
    resolveDriverAssignment.mockResolvedValue(null);
    const { caller: api } = caller({ rows: crewRows() });
    await api.crew.add(add);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("demotes the sitting person in charge when a new one is promoted", async () => {
    const rows = crewRows();
    rows.movementCrew = [
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        organizationId: TEST_ORG_ID,
        movementId: MOVEMENT_ID,
        driverId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        role: "person_in_charge",
        position: 1,
      },
    ];
    const { caller: api, db } = caller({ rows });

    await api.crew.add({ ...add, role: "person_in_charge" });

    const roles = db.table("movementCrew").map((r) => r.role);
    expect(roles.filter((r) => r === "person_in_charge")).toHaveLength(1);
  });

  it("refuses to touch the crew of a transmitted movement", async () => {
    const rows = crewRows();
    rows.movements = [movementRow({ status: "sent" })];
    const { caller: api, db } = caller({ rows });

    await expect(api.crew.add(add)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(db.table("movementCrew")).toHaveLength(0);
  });
});

describe("movement.submit", () => {
  it("refuses to transmit a manifest that fails validation, and leaves it editable", async () => {
    const rows = transmittableRows();
    rows.shipments = [];
    rows.commodities = [];
    rows.movementCrew = [];
    const { caller: api, db } = caller({ rows });

    await expect(api.submit({ id: MOVEMENT_ID })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: /Cannot transmit:.*person in charge.*at least one shipment/s,
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
