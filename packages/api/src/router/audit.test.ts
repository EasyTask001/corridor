/**
 * `audit.forEntity` — a record's history opens with that record's read
 * permission, never with a different entity's, and every entity type in the
 * map names a real permission key.
 */
import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS } from "@corridor/domain";
import { createMockCaller, TEST_ORG_ID } from "../test/mock-context";
import { HISTORY_ENTITY_PERMISSIONS } from "../services/history";
import { auditRouter } from "./audit";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(auditRouter);

describe("audit.forEntity", () => {
  it("maps every entity type to an existing permission key", () => {
    for (const key of Object.values(HISTORY_ENTITY_PERMISSIONS)) {
      expect(PERMISSION_KEYS).toContain(key);
    }
  });

  it("lets a shipment reader see shipment history but not driver history", async () => {
    const { caller } = createMockCaller(createCaller, {
      permissions: ["shipment.read"],
      rows: {
        auditLog: [
          { id: 1, organizationId: TEST_ORG_ID, actorId: null, action: "shipment.update", entityType: "shipment", entityId: "s1", before: null, after: {}, createdAt: new Date() },
        ],
      },
    });
    const rows = await caller.forEntity({ entityType: "shipment", entityId: "s1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "shipment.update" });
    await expect(caller.forEntity({ entityType: "driver", entityId: "d1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses someone with none of the read permissions", async () => {
    const { caller } = createMockCaller(createCaller, { permissions: ["billing.read"] });
    await expect(caller.forEntity({ entityType: "shipment", entityId: "s1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
