/**
 * `reporting.run` — the deterministic question translator's failures must reach
 * the client as BAD_REQUEST rather than a 500, and every run is audited because
 * a report reads across the whole tenant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuditModule from "../services/audit";
import { TEST_ORG_ID, createMockCaller, type MockContextOptions } from "../test/mock-context";

const writeAudit = vi.fn();
vi.mock("../services/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof AuditModule>()),
  writeAudit: (...args: unknown[]) => writeAudit(...args),
}));

const { reportingRouter } = await import("./reporting");
const { createCallerFactory } = await import("../trpc");
const createCaller = createCallerFactory(reportingRouter);

const caller = (options: MockContextOptions = {}) =>
  createMockCaller(createCaller, {
    permissions: ["report.read", "movement.read"],
    ...options,
  });

beforeEach(() => writeAudit.mockReset());

describe("reporting.run", () => {
  it("surfaces an unsupported measure as BAD_REQUEST, and audits nothing", async () => {
    const { caller: api } = caller();

    await expect(api.run({ question: "Average border wait time by driver" })).rejects.toMatchObject(
      {
        code: "BAD_REQUEST",
        message: /not available yet/,
      },
    );
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("answers a supported question with the translated query, rows and a summary", async () => {
    // The grouped aggregate cannot be evaluated by the fake transaction, so the
    // group row is supplied directly — what is under test is the translation,
    // the unit, and the summary built on top of it.
    const { caller: api } = caller({ sqlValues: { label: "accepted", value: 7 } });

    const result = await api.run({ question: "How many movements by status in the last 30 days?" });

    expect(result.query).toMatchObject({
      metric: "movement_count",
      dimension: "status",
      range: "last_30_days",
    });
    expect(result.unit).toBe("movements");
    expect(result.rows).toEqual([{ label: "accepted", value: 7 }]);
    expect(result.summary).toContain("7 movements");
  });

  it("reports a metric's own unit rather than a movement count", async () => {
    const { caller: api } = caller({ sqlValues: { label: "ACE", value: 12.5 } });

    const result = await api.run({ question: "Hold rate by regime this year" });

    expect(result.query).toMatchObject({ metric: "hold_rate", dimension: "regime" });
    expect(result.unit).toBe("%");
    expect(result.summary).toContain("12.5%");
  });

  it("audits the question, the translated query and the row count", async () => {
    const { caller: api } = caller({ sqlValues: { label: "ACE", value: 3 } });

    await api.run({ question: "Rejection rate by regime for ACE in the last 90 days" });

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const [, orgId, action, entityType, entityId, before, after] = writeAudit.mock.calls[0]!;
    expect({ orgId, action, entityType, entityId, before }).toEqual({
      orgId: TEST_ORG_ID,
      action: "report.run",
      entityType: "organization",
      entityId: TEST_ORG_ID,
      before: null,
    });
    expect(after).toMatchObject({
      question: "Rejection rate by regime for ACE in the last 90 days",
      query: {
        metric: "rejection_rate",
        dimension: "regime",
        range: "last_90_days",
        regime: "ACE",
      },
      rowCount: 1,
    });
  });

  it("requires both report.read and movement.read", async () => {
    const { caller: api } = caller({ permissions: ["report.read"] });

    await expect(api.run({ question: "How many movements all time?" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Missing permission: movement.read",
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
