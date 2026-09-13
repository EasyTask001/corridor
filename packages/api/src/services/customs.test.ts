import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as IntegrationsModule from "@corridor/integrations";
import { clearCustomsFixtureState } from "@corridor/integrations";
import { parseCustomsCredentials } from "./customs";

// A transparent spy over the real implementation: every existing mock/gateway
// test below still exercises the real client, but a border_connect test can
// assert on exactly what customsClientFor forwarded (env suffix/key, the
// org's company key) without reaching into the integrations package's
// private fixture-transport state.
vi.mock("@corridor/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof IntegrationsModule>();
  return { ...actual, createCustomsClient: vi.fn(actual.createCustomsClient) };
});

// transmitMovement refreshes risk findings before filing; that has its own
// coverage (risk.test.ts) and no bearing on border_connect wiring, so it's
// stubbed here exactly as movement.test.ts stubs it for the router path.
vi.mock("./risk", () => ({
  syncMovementRiskAlerts: vi.fn().mockResolvedValue({ created: 0, resolved: 0 }),
}));

beforeEach(() => clearCustomsFixtureState());

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
import { createFakeDb, TEST_ORG_ID, TEST_USER_ID, type Row } from "../test/mock-context";
import { applyStatusMessage, customsClientFor, transmitMovement } from "./customs";

const MOVEMENT_ID = "44444444-4444-4444-8444-444444444444";
const SHIPMENT_ID = "12121212-1212-4212-8212-121212121212";

function gatewayRows(status: string, regime: "ACE" | "ACI" = "ACE"): Record<string, Row[]> {
  return {
    movements: [
      {
        id: MOVEMENT_ID,
        organizationId: TEST_ORG_ID,
        regime,
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
    {
      controlNumber: "PFTRPAPS0001",
      status: "released",
      entryNumber: "30012345678",
      entryPortCode: "3801",
    },
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
    expect(db.table("movementEvents").filter((e) => e.eventType === "customs_event")).toHaveLength(
      2,
    );
    expect(db.table("shipments")[0]).toMatchObject({
      status: "released",
      entryNumber: "30012345678",
    });
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

  it("an events-only message (no decision) records the event, the entry number, and cascades the shipment's own status without changing movement status", async () => {
    const db = createFakeDb({ rows: gatewayRows("held") });
    const m = db.table("movements")[0] as never;
    const eventsOnly: CustomsStatusMessage = {
      referenceNumber: "ACE-FX00001",
      status: "held",
      decision: null,
      message: null,
      events: [
        {
          code: "entry_on_file",
          label: "Entry on file",
          occurredAt: "2026-09-06T12:00:00.000Z",
          shipmentControlNumber: "PFTRPAPS0001",
          entryNumber: "30099999999",
          entryPortCode: "3801",
        },
      ],
      shipments: [
        {
          controlNumber: "PFTRPAPS0001",
          status: "accepted",
          entryNumber: "30099999999",
          entryPortCode: "3801",
        },
      ],
      raw: {},
    };
    const r = await applyStatusMessage(db.tx, { orgId: TEST_ORG_ID, userId: null }, m, eventsOnly);
    expect(r).toEqual({ changed: false, status: "held", terminal: false });
    expect(db.table("movementEvents").filter((e) => e.eventType === "status_change")).toHaveLength(
      0,
    );
    expect(db.table("movementEvents").filter((e) => e.eventType === "customs_event")).toHaveLength(
      1,
    );
    // The shipment's own state machine still cascades on an events-only
    // message: an `accepted` shipment handed an entry number moves to
    // `entry_on_file` (accepted → accepted is not itself a legal transition).
    expect(db.table("shipments")[0]).toMatchObject({
      status: "entry_on_file",
      entryNumber: "30099999999",
      entryOnFileAt: expect.any(Date),
    });
    // Even though nothing "decided" (changed: false), the status is not
    // "pending" so the filing's own status still gets stamped.
    expect(db.table("customsSubmissions")[0]?.status).toBe("held");
  });

  it("an ACE 1C outcome (decision: null, shipment status released) moves the shipment to released", async () => {
    const db = createFakeDb({ rows: gatewayRows("held") });
    const m = db.table("movements")[0] as never;
    const releasedOutcomeOnly: CustomsStatusMessage = {
      referenceNumber: "ACE-FX00001",
      status: "pending",
      decision: null,
      message: null,
      events: [
        {
          code: "entered_and_released",
          label: "Entered and released",
          occurredAt: "2026-09-06T12:00:00.000Z",
          shipmentControlNumber: "PFTRPAPS0001",
          entryNumber: "816-1234567-8",
          entryPortCode: "0901",
        },
      ],
      shipments: [
        {
          controlNumber: "PFTRPAPS0001",
          status: "released",
          entryNumber: "816-1234567-8",
          entryPortCode: "0901",
        },
      ],
      raw: {},
    };
    const r = await applyStatusMessage(
      db.tx,
      { orgId: TEST_ORG_ID, userId: null },
      m,
      releasedOutcomeOnly,
    );
    expect(r).toEqual({ changed: false, status: "held", terminal: false });
    expect(db.table("shipments")[0]).toMatchObject({
      status: "released",
      entryNumber: "816-1234567-8",
      releasedAt: expect.any(Date),
    });
  });

  it("an RNS-flagged ACI event still lands in pars_rns_events through the events-only path", async () => {
    const db = createFakeDb({ rows: gatewayRows("accepted", "ACI") });
    const m = db.table("movements")[0] as never;
    const rnsOnly: CustomsStatusMessage = {
      referenceNumber: "ACE-FX00001",
      status: "accepted",
      decision: null,
      message: null,
      events: [
        {
          code: "released",
          label: "RNS release",
          occurredAt: "2026-09-06T12:00:05.000Z",
          shipmentControlNumber: "PFTRPAPS0001",
          raw: {
            rns: true,
            releaseCode: "R1",
            releasedAt: "2026-09-06T12:00:05.000Z",
            officeCode: "0470",
            sublocationCode: "01",
            transactionNumber: "TX-1",
            containerNumber: "CN-1",
          },
        },
      ],
      shipments: [],
      raw: {},
    };
    const r = await applyStatusMessage(db.tx, { orgId: TEST_ORG_ID, userId: null }, m, rnsOnly);
    expect(r).toEqual({ changed: false, status: "accepted", terminal: false });
    expect(db.table("movementEvents").filter((e) => e.eventType === "status_change")).toHaveLength(
      0,
    );
    const rns = db.table("parsRnsEvents");
    expect(rns).toHaveLength(1);
    expect(rns[0]).toMatchObject({
      parsNumber: "PFTRPAPS0001",
      releaseCode: "R1",
      officeCode: "0470",
      sublocationCode: "01",
      transactionNumber: "TX-1",
      containerNumber: "CN-1",
    });
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
    const r = await applyPoll(tx, TEST_ORG_ID, prepared, status, {
      durationMs: 0,
      correlationId: null,
      startedAt: new Date().toISOString(),
    });
    // First fixture poll of an ACE filing: accepted — not terminal, keep polling.
    expect(r).toMatchObject({ status: "accepted", changed: true, again: true });
    expect(db.table("integrationEvents")[0]).toMatchObject({
      operation: "poll",
      direction: "inbound",
    });
    expect(db.table("integrationConfigs")[0]?.lastPolledAt).toBeInstanceOf(Date);
    expect(db.table("customsSubmissions")[0]?.status).toBe("accepted");
  });

  it("stops polling once the window has elapsed", async () => {
    const { preparePoll, applyPoll } = await import("./customs");
    const rows = gatewayRows("sent");
    rows.integrationConfigs = [
      {
        id: "cfg-1",
        organizationId: TEST_ORG_ID,
        provider: "cbp_ace",
        mode: "gateway",
        status: "active",
        environment: "sandbox",
        settings: {},
        credentialsRef: null,
        baseUrl: null,
      },
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

// ---------------------------------------------------------------------------
// customsClientFor (border_connect mode, 0047 / Task 8)
// ---------------------------------------------------------------------------

describe("customsClientFor (border_connect mode)", () => {
  const bcConfigRow = (over: Row = {}): Row => ({
    organizationId: TEST_ORG_ID,
    provider: "cbp_ace",
    environment: "sandbox",
    status: "active",
    mode: "border_connect",
    baseUrl: null,
    credentialsRef: null,
    settings: {},
    ...over,
  });

  afterEach(() => {
    delete process.env.BORDERCONNECT_API_URL_SUFFIX;
    delete process.env.BORDERCONNECT_API_KEY;
  });

  it("returns a border_connect client carrying the org's company key and the env suffix/key", async () => {
    process.env.BORDERCONNECT_API_URL_SUFFIX = "acme-carrier";
    process.env.BORDERCONNECT_API_KEY = "bc-secret-key";
    const { createCustomsClient } = await import("@corridor/integrations");
    vi.mocked(createCustomsClient).mockClear();
    const db = createFakeDb({
      rows: {
        organizations: [{ id: TEST_ORG_ID, borderConnectCompanyKey: "BC-COMPANY-1" }],
        integrationConfigs: [bcConfigRow()],
      },
    });

    const { client } = await customsClientFor(db.tx, TEST_ORG_ID, "ACE");

    expect(client.mode).toBe("border_connect");
    expect(createCustomsClient).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "border_connect",
        apiUrlSuffix: "acme-carrier",
        apiKey: "bc-secret-key",
        companyKey: "BC-COMPANY-1",
      }),
    );
  });

  it("in production with mode border_connect and no company key throws PRECONDITION_FAILED", async () => {
    process.env.BORDERCONNECT_API_URL_SUFFIX = "acme-carrier";
    process.env.BORDERCONNECT_API_KEY = "bc-secret-key";
    const db = createFakeDb({
      rows: {
        organizations: [{ id: TEST_ORG_ID, borderConnectCompanyKey: null }],
        integrationConfigs: [bcConfigRow({ environment: "production" })],
      },
    });

    await expect(customsClientFor(db.tx, TEST_ORG_ID, "ACE")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("BorderConnect company key is not set"),
    });
  });

  it("in production with no BORDERCONNECT_API_URL_SUFFIX/API_KEY configured throws PRECONDITION_FAILED", async () => {
    const db = createFakeDb({
      rows: {
        organizations: [{ id: TEST_ORG_ID, borderConnectCompanyKey: "BC-COMPANY-1" }],
        integrationConfigs: [bcConfigRow({ environment: "production" })],
      },
    });

    await expect(customsClientFor(db.tx, TEST_ORG_ID, "ACE")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("BorderConnect credentials are not configured"),
    });
  });

  it("in sandbox with no BORDERCONNECT_API_KEY the client is not live (fixture)", async () => {
    process.env.BORDERCONNECT_API_URL_SUFFIX = "acme-carrier";
    delete process.env.BORDERCONNECT_API_KEY;
    const db = createFakeDb({
      rows: {
        organizations: [{ id: TEST_ORG_ID, borderConnectCompanyKey: null }],
        integrationConfigs: [bcConfigRow()],
      },
    });

    const { client } = await customsClientFor(db.tx, TEST_ORG_ID, "ACE");

    expect(client.mode).toBe("border_connect");
    expect((client as unknown as { live: boolean }).live).toBe(false);
  });

  it("does not read Vault credentials for border_connect (the key is env-level, never per-org Vault)", async () => {
    const db = createFakeDb({
      rows: {
        organizations: [{ id: TEST_ORG_ID, borderConnectCompanyKey: "BC-COMPANY-1" }],
        // A populated credentialsRef must NOT trigger a Vault read in this mode.
        integrationConfigs: [bcConfigRow({ credentialsRef: "vault-ref-1" })],
      },
    });

    // No NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY configured — if
    // credentialsFor() were called it would warn to console.warn and still
    // resolve, but the client must come back mock/border_connect either way.
    // The real assertion is `createCustomsClient`'s `credentials` argument.
    const { createCustomsClient } = await import("@corridor/integrations");
    vi.mocked(createCustomsClient).mockClear();

    await customsClientFor(db.tx, TEST_ORG_ID, "ACE");

    expect(createCustomsClient).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: undefined }),
    );
  });
});

// ---------------------------------------------------------------------------
// transmitMovement / scheduleDecision (border_connect mode, 0047 / Task 8)
// ---------------------------------------------------------------------------

describe("transmitMovement (border_connect mode)", () => {
  const BC_DRIVER_ID = "aaaaaaaa-1111-4111-8111-111111111111";
  const BC_TRUCK_ID = "aaaaaaaa-2222-4222-8222-222222222222";
  const BC_TRAILER_ID = "aaaaaaaa-3333-4333-8333-333333333333";
  const BC_PARTNER_ID = "aaaaaaaa-4444-4444-8444-444444444444";
  const BC_PORT_ID = "aaaaaaaa-5555-4555-8555-555555555555";
  const BC_SLOT_ID = "aaaaaaaa-6666-4666-8666-666666666666";

  const isoDay = (days: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const inDays = (days: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d;
  };

  const SQL_VALUES = {
    shipperName: "Maple Ridge Steel Ltd",
    shipperCountry: "CA",
    shipperAddress: { line1: "100 King St", city: "Hamilton", postalCode: "L8N1A1", country: "CA" },
    consigneeName: "Great Lakes Fabrication Inc",
    consigneeCountry: "US",
    consigneeAddress: {
      line1: "200 Michigan Ave",
      city: "Detroit",
      postalCode: "48226",
      country: "US",
    },
    entryPortCode: null,
    inBondDestinationPortCode: null,
  };

  /** A movement with everything `validateForTransmit` demands, filed under a
   * border_connect config — no `baseUrl`, `mode: "border_connect"`. Leaves
   * BORDERCONNECT_API_URL_SUFFIX/API_KEY unset so the client replays fixtures
   * rather than attempting a real HTTP call. */
  function bcTransmittableRows(): Record<string, Row[]> {
    return {
      organizations: [
        {
          id: TEST_ORG_ID,
          name: "Corridor Test Carrier",
          scacCode: "CTCX",
          canadianCarrierCode: "CTC1",
          usDotNumber: "7654321",
          filerCode: "F01",
          borderConnectCompanyKey: "BC-COMPANY-1",
        },
      ],
      movements: [
        {
          id: MOVEMENT_ID,
          organizationId: TEST_ORG_ID,
          regime: "ACE",
          movementNumber: "ACE-26-00042",
          tripNumber: "TRIP-1042",
          status: "draft",
          portId: BC_PORT_ID,
          carrierCode: "PFTR",
          scheduledCrossingAt: inDays(1),
          truckId: BC_TRUCK_ID,
          isEmpty: false,
          customsReferenceNumber: null,
          notes: null,
          createdBy: TEST_USER_ID,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      ports: [
        {
          id: BC_PORT_ID,
          regime: "ACE",
          kind: "port_of_entry",
          code: "3801",
          name: "Detroit",
          country: "US",
        },
      ],
      movementCrew: [
        {
          id: "bbbbbbbb-1111-4111-8111-111111111111",
          organizationId: TEST_ORG_ID,
          movementId: MOVEMENT_ID,
          driverId: BC_DRIVER_ID,
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
          // Mandatory on an ACE driver — `validateForBorderConnect` 422s a
          // driver missing it (a null would otherwise ship as
          // `dateOfBirth: null` on the wire).
          dateOfBirth: "1985-03-14",
          hazmatEndorsement: false,
        },
      ],
      drivers: [{ id: BC_DRIVER_ID, organizationId: TEST_ORG_ID }],
      driverDocuments: [],
      trucks: [
        {
          id: BC_TRUCK_ID,
          organizationId: TEST_ORG_ID,
          unitNumber: "T-101",
          status: "active",
          plateNumber: "AB12345",
          registrationExpiry: isoDay(300),
          insuranceExpiry: isoDay(200),
          vin: "1HGCM82633A123456",
        },
      ],
      trailers: [
        {
          id: BC_TRAILER_ID,
          organizationId: TEST_ORG_ID,
          unitNumber: "TR-501",
          status: "active",
          plateNumber: "TRL5011",
          registrationExpiry: isoDay(180),
        },
      ],
      movementTrailers: [
        {
          id: BC_SLOT_ID,
          organizationId: TEST_ORG_ID,
          movementId: MOVEMENT_ID,
          trailerId: BC_TRAILER_ID,
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
          shipperId: BC_PARTNER_ID,
          consigneeId: BC_PARTNER_ID,
          loadingCountry: "CA",
          loadingProvince: "ON",
          loadingCity: "Hamilton",
        },
      ],
      commodities: [
        {
          id: "cccccccc-1111-4111-8111-111111111111",
          organizationId: TEST_ORG_ID,
          shipmentId: SHIPMENT_ID,
          lineNumber: 1,
          commodityDescription: "Hot-rolled steel coils",
          hsCode: "7208.39",
          weightKg: 18000,
          weightUnit: "KG",
          quantity: 6,
          quantityUnit: "Coil",
          packagingType: "Skid",
          marksAndNumbers: null,
          valueAmount: 42000,
          valueCurrency: "USD",
          countryOfOrigin: "CA",
        },
      ],
      seals: [
        {
          id: "dddddddd-1111-4111-8111-111111111111",
          organizationId: TEST_ORG_ID,
          movementId: MOVEMENT_ID,
          movementTrailerId: BC_SLOT_ID,
          sealNumber: "SL-100231",
        },
      ],
      integrationConfigs: [
        {
          organizationId: TEST_ORG_ID,
          provider: "cbp_ace",
          environment: "sandbox",
          status: "active",
          mode: "border_connect",
          baseUrl: null,
          credentialsRef: null,
          settings: {},
        },
      ],
      movementEvents: [],
      movementAmendments: [],
      backgroundJobs: [],
      integrationEvents: [],
      customsSubmissions: [],
    };
  }

  afterEach(() => {
    delete process.env.BORDERCONNECT_API_URL_SUFFIX;
    delete process.env.BORDERCONNECT_API_KEY;
  });

  it("records a customs_submissions row with mode border_connect and status acknowledged", async () => {
    const db = createFakeDb({ rows: bcTransmittableRows(), sqlValues: SQL_VALUES });

    const result = await transmitMovement(
      db.tx,
      { orgId: TEST_ORG_ID, userId: TEST_USER_ID },
      MOVEMENT_ID,
    );

    expect(result.movement.status).toBe("sent");
    const [submission] = db.table("customsSubmissions");
    expect(submission).toMatchObject({
      organizationId: TEST_ORG_ID,
      movementId: MOVEMENT_ID,
      mode: "border_connect",
      provider: "cbp_ace",
      status: "acknowledged",
    });
  });

  it("enqueues no background job (status arrives through the BorderConnect inbox, not a poll)", async () => {
    const db = createFakeDb({ rows: bcTransmittableRows(), sqlValues: SQL_VALUES });

    await transmitMovement(db.tx, { orgId: TEST_ORG_ID, userId: TEST_USER_ID }, MOVEMENT_ID);

    expect(db.table("backgroundJobs")).toHaveLength(0);
  });
});
