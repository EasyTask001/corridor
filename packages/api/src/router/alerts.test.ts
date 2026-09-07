/**
 * `alerts.setStatus` — the permission gate, the domain transition table, and
 * what lands in the audit log.
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

const { alertsRouter } = await import("./alerts");
const { createCallerFactory } = await import("../trpc");
const createCaller = createCallerFactory(alertsRouter);

const ALERT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const alertRow = (over: Row = {}): Row => ({
  id: ALERT_ID,
  organizationId: TEST_ORG_ID,
  alertType: "document_expiry",
  severity: "warning",
  status: "open",
  source: "rules",
  title: "Truck T-102 registration expires in 3 days",
  description: null,
  dedupeKey: "truck:T-102:registration_expiry",
  acknowledgedBy: null,
  acknowledgedAt: null,
  resolvedBy: null,
  resolvedAt: null,
  ...over,
});

const caller = (rows: Row[], permissions: PermissionKey[] = ["alert.read", "alert.manage"]) =>
  createMockCaller(createCaller, { permissions, rows: { complianceAlerts: rows } });

beforeEach(() => writeAudit.mockReset());

describe("alerts.setStatus", () => {
  it("acknowledges an open alert, stamping the acting user", async () => {
    const { caller: api, db } = caller([alertRow()]);

    const row = await api.setStatus({ id: ALERT_ID, status: "acknowledged" });

    expect(row).toEqual({ id: ALERT_ID, status: "acknowledged" });
    expect(db.table("complianceAlerts")[0]).toMatchObject({
      status: "acknowledged",
      acknowledgedBy: TEST_USER_ID,
    });
  });

  it("writes an audit row carrying the status it moved from and to", async () => {
    const { caller: api } = caller([alertRow({ status: "acknowledged" })]);

    await api.setStatus({ id: ALERT_ID, status: "resolved" });

    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      TEST_ORG_ID,
      "alert.status_update",
      "compliance_alert",
      ALERT_ID,
      { status: "acknowledged" },
      { status: "resolved" },
    );
  });

  it("refuses a transition the domain table forbids, and writes nothing", async () => {
    const { caller: api, db } = caller([alertRow({ status: "resolved" })]);

    await expect(api.setStatus({ id: ALERT_ID, status: "acknowledged" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Cannot move alert from resolved to acknowledged",
    });
    expect(db.table("complianceAlerts")[0]!.status).toBe("resolved");
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("is NOT_FOUND for an alert belonging to another organization", async () => {
    const { caller: api } = caller([]);

    await expect(api.setStatus({ id: ALERT_ID, status: "resolved" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("requires alert.manage — alert.read alone cannot change a status", async () => {
    const { caller: api, db } = caller([alertRow()], ["alert.read"]);

    await expect(api.setStatus({ id: ALERT_ID, status: "dismissed" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Missing permission: alert.manage",
    });
    expect(db.table("complianceAlerts")[0]!.status).toBe("open");
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
