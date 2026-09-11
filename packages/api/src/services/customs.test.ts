import { describe, expect, it, vi } from "vitest";
import { parseCustomsCredentials } from "./customs";

describe("parseCustomsCredentials", () => {
  it("accepts the document store_integration_secret writes", () => {
    expect(parseCustomsCredentials(JSON.stringify({ apiKey: "k", apiSecret: "s" }))).toEqual({
      apiKey: "k",
      apiSecret: "s",
    });
    expect(parseCustomsCredentials(JSON.stringify({ accountId: "acct" }))).toEqual({
      accountId: "acct",
    });
  });

  it("drops fields that are not part of the contract", () => {
    expect(parseCustomsCredentials(JSON.stringify({ apiKey: "k", password: "nope" }))).toEqual({
      apiKey: "k",
    });
  });

  it("treats an absent, empty or blank secret as no credentials", () => {
    expect(parseCustomsCredentials(null)).toBeUndefined();
    expect(parseCustomsCredentials("")).toBeUndefined();
    expect(parseCustomsCredentials("{}")).toBeUndefined();
    expect(parseCustomsCredentials(JSON.stringify({ apiKey: "" }))).toBeUndefined();
  });

  it("degrades instead of throwing on a corrupt secret, and never echoes it", () => {
    const warn = vi.fn();
    expect(parseCustomsCredentials("not json at all", warn)).toBeUndefined();
    expect(parseCustomsCredentials(JSON.stringify({ apiKey: 42 }), warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [reason] of warn.mock.calls) {
      expect(reason).not.toContain("not json at all");
      expect(reason).not.toContain("42");
    }
  });
});

// ---------------------------------------------------------------------------
// Gateway status documents (0023)
// ---------------------------------------------------------------------------

import type { CustomsStatusMessage } from "@corridor/integrations";
import { createFakeDb, TEST_ORG_ID, type Row } from "../test/mock-context";
import { applyStatusMessage } from "./customs";

const MOVEMENT_ID = "44444444-4444-4444-8444-444444444444";
const SHIPMENT_ID = "12121212-1212-4212-8212-121212121212";

function gatewayRows(status: string): Record<string, Row[]> {
  return {
    movements: [
      {
        id: MOVEMENT_ID,
        organizationId: TEST_ORG_ID,
        regime: "ACE",
        movementNumber: "ACE-26-00042",
        status,
        customsReferenceNumber: "ACE-FX00001",
        portId: null,
      },
    ],
    shipments: [
      {
        id: SHIPMENT_ID,
        organizationId: TEST_ORG_ID,
        movementId: MOVEMENT_ID,
        controlNumber: "PFTRPAPS0001",
        status: status === "sent" ? "sent" : "accepted",
      },
    ],
    ports: [],
    movementEvents: [],
    movementAmendments: [],
    customsSubmissions: [
      {
        id: "sub-1",
        organizationId: TEST_ORG_ID,
        movementId: MOVEMENT_ID,
        referenceNumber: "ACE-FX00001",
        status: "acknowledged",
      },
    ],
  };
}

const released: CustomsStatusMessage = {
  referenceNumber: "ACE-FX00001",
  status: "released",
  decision: "released",
  message: "Released at primary.",
  events: [
    {
      code: "entry_on_file",
      label: "Entry on file",
      occurredAt: "2026-09-06T12:00:00.000Z",
      shipmentControlNumber: "PFTRPAPS0001",
      entryNumber: "30012345678",
      entryPortCode: "3801",
    },
    { code: "released", label: "Released", occurredAt: "2026-09-06T12:00:01.000Z" },
  ],
  shipments: [
    { controlNumber: "PFTRPAPS0001", status: "released", entryNumber: "30012345678", entryPortCode: "3801" },
  ],
  raw: {},
};

describe("applyStatusMessage", () => {
  it("walks sent → accepted → released in one document and stamps the filing", async () => {
    const db = createFakeDb({ rows: gatewayRows("sent") });
    const m = db.table("movements")[0] as never;
    const r = await applyStatusMessage(db.tx, { orgId: TEST_ORG_ID, userId: null }, m, released);
    expect(r).toEqual({ changed: true, status: "released", terminal: true });
    const transitions = db
      .table("movementEvents")
      .filter((e) => e.eventType === "status_change")
      .map((e) => `${e.fromStatus}→${e.toStatus}`);
    expect(transitions).toEqual(["sent→accepted", "accepted→released"]);
    // Events and entries ride the final step only.
    expect(db.table("movementEvents").filter((e) => e.eventType === "customs_event")).toHaveLength(2);
    expect(db.table("shipments")[0]).toMatchObject({ status: "released", entryNumber: "30012345678" });
    expect(db.table("customsSubmissions")[0]?.status).toBe("released");
  });

  it("leaves a pending document alone and keeps the filing acknowledged", async () => {
    const db = createFakeDb({ rows: gatewayRows("sent") });
    const m = db.table("movements")[0] as never;
    const r = await applyStatusMessage(db.tx, { orgId: TEST_ORG_ID, userId: null }, m, {
      ...released,
      status: "pending",
      decision: null,
      events: [],
      shipments: [],
    });
    expect(r).toEqual({ changed: false, status: "sent", terminal: false });
    expect(db.table("movementEvents")).toHaveLength(0);
  });

  it("a cancellation from the gateway cancels the movement", async () => {
    const db = createFakeDb({ rows: gatewayRows("accepted") });
    const m = db.table("movements")[0] as never;
    const r = await applyStatusMessage(db.tx, { orgId: TEST_ORG_ID, userId: null }, m, {
      ...released,
      status: "cancelled",
      decision: null,
      events: [],
      shipments: [],
    });
    expect(r).toMatchObject({ changed: true, status: "cancelled", terminal: true });
  });
});

describe("pollCustomsStatus (gateway mode, fixture replay)", () => {
  it("polls the gateway, applies the answer, stamps last_polled_at and asks to poll again", async () => {
    const { preparePoll, applyPoll } = await import("./customs");
    const rows = gatewayRows("sent");
    rows.integrationConfigs = [
      {
        id: "cfg-1",
        organizationId: TEST_ORG_ID,
        provider: "cbp_ace",
        environment: "sandbox",
        status: "active",
        mode: "gateway",
        baseUrl: null,
        credentialsRef: null,
        settings: {},
      },
    ];
    rows.integrationEvents = [];
    const db = createFakeDb({ rows });
    const tx = db.tx;
    const prepared = await preparePoll(tx, TEST_ORG_ID, {
      movementId: MOVEMENT_ID,
      referenceNumber: "ACE-FX00001",
      startedAt: new Date().toISOString(),
    });
    expect(prepared.skip).toBe(false);
    if (prepared.skip) throw new Error("unreachable");
    const status = await prepared.client.fetchStatus(prepared.ref);
    const r = await applyPoll(tx, TEST_ORG_ID, prepared, status, { durationMs: 0, correlationId: null, startedAt: new Date().toISOString() });
    // First fixture poll of an ACE filing: accepted — not terminal, keep polling.
    expect(r).toMatchObject({ status: "accepted", changed: true, again: true });
    expect(db.table("integrationEvents")[0]).toMatchObject({ operation: "poll", direction: "inbound" });
    expect(db.table("integrationConfigs")[0]?.lastPolledAt).toBeInstanceOf(Date);
    expect(db.table("customsSubmissions")[0]?.status).toBe("accepted");
  });

  it("stops polling once the window has elapsed", async () => {
    const { preparePoll, applyPoll } = await import("./customs");
    const rows = gatewayRows("sent");
    rows.integrationConfigs = [
      { id: "cfg-1", organizationId: TEST_ORG_ID, provider: "cbp_ace", mode: "gateway", status: "active", environment: "sandbox", settings: {}, credentialsRef: null, baseUrl: null },
    ];
    rows.integrationEvents = [];
    const db = createFakeDb({ rows });
    const tx = db.tx;
    const prepared = await preparePoll(tx, TEST_ORG_ID, {
      movementId: MOVEMENT_ID,
      referenceNumber: "ACE-FX00001",
      startedAt: new Date(Date.now() - 49 * 3_600_000).toISOString(),
    });
    expect(prepared.skip).toBe(false);
    if (prepared.skip) throw new Error("unreachable");
    const status = await prepared.client.fetchStatus(prepared.ref);
    const r = await applyPoll(tx, TEST_ORG_ID, prepared, status, {
      durationMs: 0,
      correlationId: null,
      startedAt: new Date(Date.now() - 49 * 3_600_000).toISOString(),
    });
    expect(r.again).toBe(false);
    expect(r.reason).toBe("poll window elapsed");
  });
});
