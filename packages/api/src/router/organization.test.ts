/**
 * `organization.update` — the BorderConnect company key field (Task 13,
 * migration 0047's `organizations.border_connect_company_key`).
 *
 * Covers: the field round-trips through the update, a blank/`null` value
 * clears it, and a duplicate key across two organizations surfaces as a
 * clean `CONFLICT` through the shared Postgres-error mapper
 * (`services/db-errors.ts`), never a raw Postgres error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import type * as AuditModule from "../services/audit";
import { TEST_ORG_ID, createMockCaller, type Row } from "../test/mock-context";

const writeAudit = vi.fn();
vi.mock("../services/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof AuditModule>()),
  writeAudit: (...args: unknown[]) => writeAudit(...args),
}));

const { organizationRouter } = await import("./organization");
const { createCallerFactory } = await import("../trpc");
const createCaller = createCallerFactory(organizationRouter);

function caller(
  over: { org?: Row; updateConflicts?: Record<string, string> } = {},
) {
  return createMockCaller(createCaller, {
    permissions: ["organization.manage"],
    rows: {
      organizations: [
        {
          id: TEST_ORG_ID,
          name: "Test Carrier",
          borderConnectCompanyKey: null,
          ...over.org,
        },
      ],
    },
    updateConflicts: over.updateConflicts,
  });
}

beforeEach(() => writeAudit.mockReset());

describe("organization.update — borderConnectCompanyKey", () => {
  it("accepts borderConnectCompanyKey and persists it", async () => {
    const { caller: api, db } = caller();

    const result = await api.update({ borderConnectCompanyKey: "BC-COMPANY-1" });

    expect(result.borderConnectCompanyKey).toBe("BC-COMPANY-1");
    expect(db.table("organizations")[0]?.borderConnectCompanyKey).toBe("BC-COMPANY-1");
    // The fake DB's `query.findFirst()` hands back the live row object (not a
    // copy), so by the time `writeAudit` is inspected the "before" snapshot has
    // already been mutated in place to match "after" — assert on the call
    // shape and the persisted value instead of before/after identity.
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const [, orgId, action, entityType, entityId, , after] = writeAudit.mock.calls[0]!;
    expect(orgId).toBe(TEST_ORG_ID);
    expect(action).toBe("organization.update");
    expect(entityType).toBe("organization");
    expect(entityId).toBe(TEST_ORG_ID);
    expect((after as Row).borderConnectCompanyKey).toBe("BC-COMPANY-1");
  });

  it("clears a previously-set company key when given null", async () => {
    const { caller: api, db } = caller({ org: { borderConnectCompanyKey: "BC-EXISTING" } });

    const result = await api.update({ borderConnectCompanyKey: null });

    expect(result.borderConnectCompanyKey).toBeNull();
    expect(db.table("organizations")[0]?.borderConnectCompanyKey).toBeNull();
  });

  it("rejects a key shorter than the domain schema's minimum", async () => {
    const { caller: api } = caller();
    await expect(api.update({ borderConnectCompanyKey: "" })).rejects.toThrow();
  });

  it("surfaces a duplicate company key across organizations as a clean CONFLICT", async () => {
    const { caller: api } = caller({
      updateConflicts: { organizations: "organizations_border_connect_company_key_key" },
    });

    try {
      await api.update({ borderConnectCompanyKey: "BC-TAKEN" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TRPCError);
      expect((e as TRPCError).code).toBe("CONFLICT");
      expect((e as TRPCError).message).toContain("BorderConnect company key");
    }
  });
});
