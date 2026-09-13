/**
 * The BorderConnect inbox drain end-to-end (services/borderconnect.ts,
 * migration 0047). Two organizations share one BorderConnect
 * inbox, discriminated only by `companyKey` inside each message — this is
 * the correctness-critical multi-tenant routing path: a bug here could
 * apply one carrier's customs decision to another carrier's movement.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/api test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, desc, eq, inArray, schema, withServiceRole } from "@corridor/db";
import {
  buildManifest,
  clearCustomsFixtureState,
  type BorderConnectTransport,
  type ManifestSource,
} from "@corridor/integrations";
import {
  drainBorderConnectInbox,
  processInboxRow,
  storeInboundMessages,
} from "./services/borderconnect";
import { customsClientFor } from "./services/customs";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

const conn = createDb(DB_URL, { max: 4 });
const db = conn.db;
const { organizations, movements, customsSubmissions, customsInbox, integrationEvents } = schema;

/** A transport whose `receive()` hands back exactly the messages this test queues, once. */
function fakeTransport(messages: Record<string, unknown>[]): BorderConnectTransport {
  let queue = messages;
  return {
    send: () => Promise.reject(new Error("not used by the drain")),
    receive: () => {
      const out = queue;
      queue = [];
      return Promise.resolve(out);
    },
  };
}

let orgA: string;
let orgB: string;
let companyKeyA: string;
let companyKeyB: string;
let movementA: string;
let movementB1: string;
let movementB2: string;
let submissionA: string;
let submissionB2: string;
const tripA = `TRIPA-${Date.now()}`;
const tripB1 = `TRIPB1-${Date.now()}`;
const tripB2 = `TRIPB2-${Date.now()}`;
const sendIdA = `send-a-${Date.now()}`;
const sendIdB2 = `send-b2-${Date.now()}`;
// Unrouted, so it never gets an organization_id and never rides the
// organizations cascade-delete in afterAll — must be unique per run (and
// explicitly cleaned up) or a later run's identical payload hash matches
// this leftover row and is wrongly counted as a duplicate.
const unknownCompanyKey = `c-Z-does-not-exist-${Date.now()}`;

beforeAll(async () => {
  companyKeyA = `c-A-${Date.now()}`;
  companyKeyB = `c-B-${Date.now()}`;

  const [rowA, rowB] = await db
    .insert(organizations)
    .values([
      { name: `BC Drain A ${Date.now()}`, borderConnectCompanyKey: companyKeyA },
      { name: `BC Drain B ${Date.now()}`, borderConnectCompanyKey: companyKeyB },
    ])
    .returning({ id: organizations.id });
  orgA = rowA!.id;
  orgB = rowB!.id;

  const [mA, mB1, mB2] = await db
    .insert(movements)
    .values([
      {
        organizationId: orgA,
        regime: "ACE",
        movementNumber: `BC-A-${Date.now()}`,
        tripNumber: tripA,
        status: "sent",
      },
      {
        organizationId: orgB,
        regime: "ACI",
        movementNumber: `BC-B1-${Date.now()}`,
        tripNumber: tripB1,
        status: "sent",
      },
      {
        organizationId: orgB,
        regime: "ACI",
        movementNumber: `BC-B2-${Date.now()}`,
        tripNumber: tripB2,
        status: "sent",
      },
    ])
    .returning({ id: movements.id });
  movementA = mA!.id;
  movementB1 = mB1!.id;
  movementB2 = mB2!.id;

  const [sA, , sB2] = await db
    .insert(customsSubmissions)
    .values([
      {
        organizationId: orgA,
        movementId: movementA,
        kind: "original",
        provider: "cbp_ace",
        mode: "border_connect",
        referenceNumber: tripA,
        correlationId: sendIdA,
        status: "sent",
      },
      {
        organizationId: orgB,
        movementId: movementB1,
        kind: "original",
        provider: "cbsa_aci",
        mode: "border_connect",
        referenceNumber: tripB1,
        correlationId: `send-b1-${Date.now()}`,
        status: "sent",
      },
      {
        organizationId: orgB,
        movementId: movementB2,
        kind: "original",
        provider: "cbsa_aci",
        mode: "border_connect",
        referenceNumber: tripB2,
        correlationId: sendIdB2,
        status: "sent",
      },
    ])
    .returning({ id: customsSubmissions.id });
  submissionA = sA!.id;
  submissionB2 = sB2!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(inArray(organizations.id, [orgA, orgB]));
  // Never owned by an org, so the cascade above never reaches it.
  await withServiceRole(db, (tx) =>
    tx.delete(customsInbox).where(eq(customsInbox.companyKey, unknownCompanyKey)),
  );
  await conn.sql.end();
});

async function inboxRowsFor(orgIds: string[]) {
  return withServiceRole(db, (tx) =>
    tx.select().from(customsInbox).where(inArray(customsInbox.organizationId, orgIds)),
  );
}

describe("drainBorderConnectInbox", () => {
  it("routes a mixed inbox to the right org/movement, isolates tenants, dedupes, and is safe to re-run", async () => {
    const apiResponseImportedA = {
      data: "API_RESPONSE",
      companyKey: companyKeyA,
      sendId: sendIdA,
      tripNumber: tripA,
      status: "IMPORTED",
    };
    const aceProcessingResponseA = {
      data: "ACE_RESPONSE",
      companyKey: companyKeyA,
      tripNumber: tripA,
      processingResponse: { accepted: true },
    };
    const aciNoticeMatchedB = {
      data: "ACI_NOTICE",
      companyKey: companyKeyB,
      tripNumber: tripB1,
      type: "MATCHED",
      cargoControlNumber: `CCN-${Date.now()}`,
    };
    const apiResponseDataErrorB = {
      data: "API_RESPONSE",
      companyKey: companyKeyB,
      sendId: sendIdB2,
      tripNumber: tripB2,
      status: "DATA_ERROR",
      errors: [{ identifier: "shipment-1", note: "missing HS code" }],
    };
    const unknownCompany = {
      data: "API_RESPONSE",
      companyKey: unknownCompanyKey,
      status: "OK",
    };

    const messages = [
      apiResponseImportedA,
      aceProcessingResponseA,
      aciNoticeMatchedB,
      apiResponseDataErrorB,
      unknownCompany,
      apiResponseImportedA, // exact duplicate of the first message
    ];

    const result = await drainBorderConnectInbox(db, { transport: fakeTransport(messages) });

    expect(result.received).toBe(6);
    expect(result.stored).toBe(5); // the duplicate is not a distinct row
    expect(result.duplicates).toBe(1);
    expect(result.errors).toBe(0);
    // "applied" covers every customs_status row (both the ACE_RESPONSE
    // decision and the ACI_NOTICE events-only message) and the rejected
    // API_RESPONSE — the outcome enum has no separate "events only" case.
    expect(result.processed).toMatchObject({ applied: 3, acknowledged: 1, unroutable: 1 });

    // --- Org A: accepted, with an `accepted` customs_event ---
    const [mA] = await db.select().from(movements).where(eq(movements.id, movementA));
    expect(mA?.status).toBe("accepted");
    const eventsA = await withServiceRole(db, (tx) =>
      tx
        .select()
        .from(schema.movementEvents)
        .where(eq(schema.movementEvents.movementId, movementA)),
    );
    expect(
      eventsA.some(
        (e) =>
          e.eventType === "customs_event" &&
          (e.payload as { code?: string } | null)?.code === "accepted",
      ),
    ).toBe(true);
    const [subA] = await db
      .select()
      .from(customsSubmissions)
      .where(eq(customsSubmissions.id, submissionA));
    expect(subA?.status).toBe("accepted");

    // --- Org B movement 1: unchanged status, but has a pars_matched event ---
    const [mB1] = await db.select().from(movements).where(eq(movements.id, movementB1));
    expect(mB1?.status).toBe("sent");
    const eventsB1 = await withServiceRole(db, (tx) =>
      tx
        .select()
        .from(schema.movementEvents)
        .where(eq(schema.movementEvents.movementId, movementB1)),
    );
    expect(
      eventsB1.some(
        (e) =>
          e.eventType === "customs_event" &&
          (e.payload as { code?: string } | null)?.code === "pars_matched",
      ),
    ).toBe(true);

    // --- Org B's second submission: rejected, its own (separate) movement rejected too ---
    const [subB2] = await db
      .select()
      .from(customsSubmissions)
      .where(eq(customsSubmissions.id, submissionB2));
    expect(subB2?.status).toBe("rejected");
    const [mB2] = await db.select().from(movements).where(eq(movements.id, movementB2));
    expect(mB2?.status).toBe("rejected");

    // --- Multi-tenant isolation: org A's rows never carry org B's id and vice versa ---
    const rowsA = await inboxRowsFor([orgA]);
    const rowsB = await inboxRowsFor([orgB]);
    expect(rowsA.length).toBe(2); // API_RESPONSE IMPORTED + ACE_RESPONSE
    expect(rowsB.length).toBe(2); // ACI_NOTICE MATCHED + API_RESPONSE DATA_ERROR
    for (const r of rowsA) expect(r.organizationId).toBe(orgA);
    for (const r of rowsB) expect(r.organizationId).toBe(orgB);

    // --- Every routed row is fully processed ---
    for (const r of [...rowsA, ...rowsB]) {
      expect(r.processedAt).not.toBeNull();
      expect(r.movementId).not.toBeNull();
    }

    // --- The unknown companyKey row is kept, not discarded, and flagged ---
    const unknownRows = await withServiceRole(db, (tx) =>
      tx
        .select()
        .from(customsInbox)
        .where(eq(customsInbox.companyKey, unknownCompanyKey)),
    );
    expect(unknownRows).toHaveLength(1);
    expect(unknownRows[0]?.organizationId).toBeNull();
    expect(unknownRows[0]?.processedAt).not.toBeNull();
    expect(unknownRows[0]?.processingError).toBe("unknown companyKey");

    // --- integration_events carries the bc-inbox correlation id for the customs_status rows ---
    const aceRow = rowsA.find((r) => r.dataType === "ACE_RESPONSE");
    const aciRow = rowsB.find((r) => r.dataType === "ACI_NOTICE");
    expect(aceRow).toBeDefined();
    expect(aciRow).toBeDefined();
    const events = await withServiceRole(db, (tx) =>
      tx
        .select()
        .from(integrationEvents)
        .where(
          inArray(integrationEvents.correlationId, [
            `bc-inbox:${aceRow!.id}`,
            `bc-inbox:${aciRow!.id}`,
          ]),
        ),
    );
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.direction === "inbound")).toBe(true);

    // --- A second, empty drain is a no-op ---
    const second = await drainBorderConnectInbox(db, { transport: fakeTransport([]) });
    expect(second).toMatchObject({ received: 0, stored: 0, duplicates: 0, errors: 0, processed: {} });
  });
});

/**
 * F3: BorderConnect amendments re-upload under the SAME trip number as the
 * original filing, so `applyStatusMessage`'s final `customs_submissions`
 * update must target the one row the message is actually about — never
 * every row sharing that `(organization_id, reference_number)` pair, or a
 * rejected amendment corrupts the audit trail for an already-accepted
 * original filing it has no bearing on.
 */
describe("amendment rejection is scoped to its own submission row", () => {
  let amOrgId: string;
  let amMovementId: string;
  let originalSubmissionId: string;
  let amendmentSubmissionId: string;
  const amCompanyKey = `c-AM-${Date.now()}`;
  const amTripNumber = `TRIPAM-${Date.now()}`;
  const amendSendId = `send-am-${Date.now()}`;

  beforeAll(async () => {
    const [org] = await db
      .insert(organizations)
      .values({ name: `BC Amendment Scope ${Date.now()}`, borderConnectCompanyKey: amCompanyKey })
      .returning({ id: organizations.id });
    amOrgId = org!.id;

    const [m] = await db
      .insert(movements)
      .values({
        organizationId: amOrgId,
        regime: "ACE",
        movementNumber: `BC-AM-${Date.now()}`,
        tripNumber: amTripNumber,
        // "sent" mirrors `transmitAmendment`'s re-transmit state: the
        // original was already accepted, and filing the amendment moves the
        // movement back to "sent" while its outcome is pending.
        status: "sent",
      })
      .returning({ id: movements.id });
    amMovementId = m!.id;

    const [original, amendment] = await db
      .insert(customsSubmissions)
      .values([
        {
          organizationId: amOrgId,
          movementId: amMovementId,
          kind: "original",
          provider: "cbp_ace",
          mode: "border_connect",
          referenceNumber: amTripNumber,
          correlationId: `send-am-orig-${Date.now()}`,
          status: "accepted",
        },
        {
          organizationId: amOrgId,
          movementId: amMovementId,
          kind: "amendment",
          provider: "cbp_ace",
          mode: "border_connect",
          referenceNumber: amTripNumber,
          correlationId: amendSendId,
          status: "sent",
        },
      ])
      .returning({ id: customsSubmissions.id });
    originalSubmissionId = original!.id;
    amendmentSubmissionId = amendment!.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, amOrgId));
  });

  it("a rejected API_RESPONSE for the amendment's sendId stamps only the amendment row", async () => {
    const apiResponseFailure = {
      data: "API_RESPONSE",
      companyKey: amCompanyKey,
      sendId: amendSendId,
      tripNumber: amTripNumber,
      status: "DATA_ERROR",
      errors: [{ identifier: "shipment-1", note: "missing HS code" }],
    };

    const result = await drainBorderConnectInbox(db, {
      transport: fakeTransport([apiResponseFailure]),
    });
    expect(result.processed).toMatchObject({ applied: 1 });

    const [original] = await db
      .select()
      .from(customsSubmissions)
      .where(eq(customsSubmissions.id, originalSubmissionId));
    const [amendment] = await db
      .select()
      .from(customsSubmissions)
      .where(eq(customsSubmissions.id, amendmentSubmissionId));
    expect(amendment?.status).toBe("rejected");
    // The bug: before the fix, this update matched on (org, reference_number)
    // alone and flipped the already-accepted original to "rejected" too.
    expect(original?.status).toBe("accepted");

    const [movement] = await db.select().from(movements).where(eq(movements.id, amMovementId));
    expect(movement?.status).toBe("rejected");
  });
});

describe("storeInboundMessages dedup", () => {
  it("dedupes two messages with identical content but different key insertion order", async () => {
    // Real BorderConnect retries / an intermediate proxy could re-serialize a
    // message with its keys in a different order — the hash must not care.
    const marker = `dedup-key-order-${Date.now()}`;
    const left = {
      data: "API_RESPONSE",
      companyKey: marker,
      status: "OK",
      meta: { sendId: "s1", tripNumber: "t1" },
    };
    const right = {
      meta: { tripNumber: "t1", sendId: "s1" },
      status: "OK",
      companyKey: marker,
      data: "API_RESPONSE",
    };

    try {
      const result = await withServiceRole(db, (tx) => storeInboundMessages(tx, [left, right]));
      expect(result).toEqual({ stored: 1, duplicates: 1 });

      const rows = await withServiceRole(db, (tx) =>
        tx.select().from(customsInbox).where(eq(customsInbox.companyKey, marker)),
      );
      expect(rows).toHaveLength(1);
    } finally {
      await withServiceRole(db, (tx) =>
        tx.delete(customsInbox).where(eq(customsInbox.companyKey, marker)),
      );
    }
  });
});

describe("RNS releases and SYSTEM_ALERT notices (Task 11)", () => {
  const { shipments, parsRnsEvents, carrierNotices, movementEvents } = schema;
  let rnsOrgId: string;
  let rnsMovementId: string;
  let rnsShipmentId: string;
  let rnsControlNumber: string;
  const rnsInboxIds: number[] = [];
  const alertInboxIds: number[] = [];
  const alertExternalIds: string[] = [];

  beforeAll(async () => {
    const [org] = await db
      .insert(organizations)
      .values({ name: `BC RNS ${Date.now()}` })
      .returning({ id: organizations.id });
    rnsOrgId = org!.id;

    // shipments_guard() only allows INSERTing a shipment onto a movement that
    // is draft/rejected (movement_is_editable) — so the movement starts
    // draft and is advanced through its own state machine (draft -> sent ->
    // accepted) afterward, same as the app's real flow.
    const [m] = await db
      .insert(movements)
      .values({
        organizationId: rnsOrgId,
        regime: "ACI",
        movementNumber: `BC-RNS-${Date.now()}`,
        tripNumber: `TRIP-RNS-${Date.now()}`,
        status: "draft",
      })
      .returning({ id: movements.id });
    rnsMovementId = m!.id;

    const [s] = await withServiceRole(db, (tx) =>
      tx
        .insert(shipments)
        .values({
          organizationId: rnsOrgId,
          movementId: rnsMovementId,
          regime: "ACI",
          carrierCode: "7ELU",
          cargoType: "regular",
          controlReference: `RNS${Date.now()}`.slice(0, 20),
          isPars: true,
        })
        .returning({ id: shipments.id, controlNumber: shipments.controlNumber }),
    );
    rnsShipmentId = s!.id;
    rnsControlNumber = s!.controlNumber;

    await db.update(movements).set({ status: "sent" }).where(eq(movements.id, rnsMovementId));
    await db.update(movements).set({ status: "accepted" }).where(eq(movements.id, rnsMovementId));
    // The shipment's own status cascade (`markShipmentsSent`/
    // `applyShipmentOutcomes`) is a separate app-level concern from this
    // fixture — set directly to the end state this test needs (an accepted
    // shipment ready for RNS to release).
    await db.update(shipments).set({ status: "accepted" }).where(eq(shipments.id, rnsShipmentId));
  });

  afterAll(async () => {
    // pars_rns_events is append-only (0027's `reject_modification` trigger
    // fires on DELETE too, including one raised by this org's own `on delete
    // cascade` FK) — so the org itself is left behind rather than deleted;
    // this is disposable local test data, cleaned up wholesale by
    // `pnpm db:reset`, not per-run.
    await withServiceRole(db, (tx) =>
      tx.delete(customsInbox).where(eq(customsInbox.organizationId, rnsOrgId)),
    );
    if (rnsInboxIds.length > 0) {
      await withServiceRole(db, (tx) =>
        tx.delete(customsInbox).where(inArray(customsInbox.id, rnsInboxIds)),
      );
    }
    if (alertInboxIds.length > 0) {
      await withServiceRole(db, (tx) =>
        tx.delete(customsInbox).where(inArray(customsInbox.id, alertInboxIds)),
      );
    }
    if (alertExternalIds.length > 0) {
      await withServiceRole(db, (tx) =>
        tx.delete(carrierNotices).where(inArray(carrierNotices.externalId, alertExternalIds)),
      );
    }
  });

  it("routes an RNS release for a PARS shipment: pars_rns_events row, shipment released, a released customs_event on the movement", async () => {
    // Real BorderConnect wire shape (RNS Shipment JSON Reference Manual,
    // sections 1.7/1.11): releaseOffice and the release code/timestamp are
    // nested under `status`, not flat top-level fields.
    const rnsMessage = {
      data: "RNS_SHIPMENT",
      cargoControlNumber: rnsControlNumber,
      transactionNumber: "73423483212345",
      releaseOffice: { number: "0470", name: "Test Office" },
      status: {
        dateTime: "2026-09-12 10:00:00",
        releaseCode: { number: "4", shortName: "Released", longName: "Goods Released" },
      },
    };

    const result = await drainBorderConnectInbox(db, { transport: fakeTransport([rnsMessage]) });
    expect(result.processed.rns).toBe(1);

    const [inboxRow] = await withServiceRole(db, (tx) =>
      tx
        .select()
        .from(customsInbox)
        .where(eq(customsInbox.cargoControlNumber, rnsControlNumber)),
    );
    expect(inboxRow).toBeDefined();
    rnsInboxIds.push(inboxRow!.id);
    expect(inboxRow!.processedAt).not.toBeNull();
    expect(inboxRow!.organizationId).toBe(rnsOrgId);
    expect(inboxRow!.movementId).toBe(rnsMovementId);

    const [rnsRow] = await withServiceRole(db, (tx) =>
      tx.select().from(parsRnsEvents).where(eq(parsRnsEvents.shipmentId, rnsShipmentId)),
    );
    expect(rnsRow).toBeDefined();
    expect(rnsRow!.organizationId).toBe(rnsOrgId);
    expect(rnsRow!.parsNumber).toBe(rnsControlNumber);
    expect(rnsRow!.releaseCode).toBe("4");
    expect(rnsRow!.transactionNumber).toBe("73423483212345");

    const [shipment] = await db.select().from(shipments).where(eq(shipments.id, rnsShipmentId));
    expect(shipment?.status).toBe("released");
    expect(shipment?.releasedAt).not.toBeNull();

    const events = await withServiceRole(db, (tx) =>
      tx.select().from(movementEvents).where(eq(movementEvents.movementId, rnsMovementId)),
    );
    expect(
      events.some(
        (e) =>
          e.eventType === "customs_event" &&
          (e.payload as { code?: string } | null)?.code === "released",
      ),
    ).toBe(true);
  });

  it("marks an RNS message for an unknown CCN unroutable", async () => {
    const unknownCcn = `NOPE${Date.now()}`;
    const rnsMessage = {
      data: "RNS_SHIPMENT",
      cargoControlNumber: unknownCcn,
      transactionNumber: "00000000000000",
      releaseOffice: { number: "0470", name: "Test Office" },
      status: {
        dateTime: "2026-09-12 10:00:00",
        releaseCode: { number: "4", shortName: "Released", longName: "Goods Released" },
      },
    };

    const result = await drainBorderConnectInbox(db, { transport: fakeTransport([rnsMessage]) });
    expect(result.processed.unroutable).toBeGreaterThanOrEqual(1);

    const [inboxRow] = await withServiceRole(db, (tx) =>
      tx.select().from(customsInbox).where(eq(customsInbox.cargoControlNumber, unknownCcn)),
    );
    expect(inboxRow).toBeDefined();
    rnsInboxIds.push(inboxRow!.id);
    expect(inboxRow!.organizationId).toBeNull();
    expect(inboxRow!.processedAt).not.toBeNull();
    expect(inboxRow!.processingError).toBe("unknown CCN");
  });

  it("fans a SYSTEM_ALERT out to both providers' carrier_notices, deduped by external_id", async () => {
    const alertMessage = {
      data: "SYSTEM_ALERT",
      message: `Scheduled maintenance ${Date.now()}`,
    };

    const result = await drainBorderConnectInbox(db, { transport: fakeTransport([alertMessage]) });
    expect(result.processed.alert).toBe(1);

    const [inboxRow] = await withServiceRole(db, (tx) =>
      tx
        .select()
        .from(customsInbox)
        .where(eq(customsInbox.dataType, "SYSTEM_ALERT"))
        .orderBy(desc(customsInbox.id))
        .limit(1),
    );
    expect(inboxRow).toBeDefined();
    expect((inboxRow!.payload as { message?: string }).message).toBe(alertMessage.message);
    alertInboxIds.push(inboxRow!.id);
    expect(inboxRow!.processedAt).not.toBeNull();

    const expectedIds = [
      `borderconnect:${inboxRow!.payloadSha256}:cbp_ace`,
      `borderconnect:${inboxRow!.payloadSha256}:cbsa_aci`,
    ];
    alertExternalIds.push(...expectedIds);
    const notices = await withServiceRole(db, (tx) =>
      tx.select().from(carrierNotices).where(inArray(carrierNotices.externalId, expectedIds)),
    );
    expect(notices).toHaveLength(2);
    expect(notices.map((n) => n.provider).sort()).toEqual(["cbp_ace", "cbsa_aci"]);
    for (const n of notices) {
      expect(n.severity).toBe("warning");
      expect(n.title).toBe("BorderConnect system alert");
      expect(n.body).toBe(alertMessage.message);
    }

    // Directly exercises the external_id dedup a re-delivered/re-raced alert
    // relies on: recordCarrierNotices is idempotent on a second call with the
    // same externalIds (a literal duplicate wire message never reaches here
    // twice — storeInboundMessages's payload_sha256 dedup already prevents
    // that upstream — so this asserts the DB-level guarantee directly).
    const { recordCarrierNotices } = await import("./services/notices");
    const second = await withServiceRole(db, (tx) =>
      recordCarrierNotices(
        tx,
        notices.map((n) => ({
          provider: n.provider,
          externalId: n.externalId,
          severity: n.severity,
          title: n.title,
          body: n.body,
          startsAt: n.startsAt?.toISOString() ?? null,
          endsAt: n.endsAt?.toISOString() ?? null,
          publishedAt: n.publishedAt.toISOString(),
        })),
      ),
    );
    expect(second.inserted).toBe(0);
    const stillTwo = await withServiceRole(db, (tx) =>
      tx.select().from(carrierNotices).where(inArray(carrierNotices.externalId, expectedIds)),
    );
    expect(stillTwo).toHaveLength(2);
  });
});

/**
 * Finding 1 of the final whole-branch review: the offline demo path. The
 * org-scoped client `customsClientFor` hands out (fixture mode, no
 * BORDERCONNECT_API_KEY) and the drain's own fixture fallback must share one
 * queue partition — keying the client's by organization id while the drain
 * read a fixed `"system"` meant transmit → drain could never connect without a
 * real BorderConnect account.
 */
describe("fixture transmit → drain round trip (no BorderConnect credentials)", () => {
  let fxOrgId: string;
  let fxMovementId: string;
  const fxCompanyKey = `c-FX-${Date.now()}`;
  const fxMovementNumber = `FX${Date.now().toString().slice(-6)}`;
  let savedApiKey: string | undefined;
  let savedSuffix: string | undefined;

  /** A minimal, fully-populated ACE manifest — every field `validateForBorderConnect` insists on. */
  function makeAceSource(): ManifestSource {
    return {
      organization: {
        name: "Corridor Fixture Round Trip",
        usDotNumber: "1234567",
        filerCode: "F01",
        scacCode: "PFTR",
        canadianCarrierCode: "1234567",
        timezone: "America/Toronto",
      },
      movement: {
        regime: "ACE",
        movementNumber: fxMovementNumber,
        tripNumber: null,
        carrierCode: "PFTR",
        port: { code: "3801" },
        scheduledCrossingAt: new Date(Date.now() + 86_400_000).toISOString(),
        isEmpty: false,
        iitIndicator: "none",
        aciLvs: false,
        aciPostal: false,
        aciFlyingTruck: false,
        aciInTransit: false,
        aciIit: false,
      },
      crew: [
        {
          role: "person_in_charge",
          firstName: "Fixture",
          lastName: "Driver",
          gender: "M",
          licenseNumber: "L1",
          licenseJurisdiction: "ON",
          citizenship: "CA",
          dateOfBirth: "1985-03-14",
          hazmatEndorsement: false,
          documents: [
            {
              documentType: "passport",
              documentNumber: "P1234567",
              issuingCountry: "CA",
              issuingState: null,
              expiresOn: "2030-01-01",
            },
          ],
        },
      ],
      truck: {
        unitNumber: "T-101",
        vin: "1FUJA6CV12LJ12345",
        plateNumber: "AB1234",
        plateJurisdiction: "ON",
        dotNumber: "1234567",
        truckType: "TR",
        insurancePolicyNumber: null,
        insuranceCompany: null,
        insuranceAmount: null,
        insuranceYear: null,
        plates: [],
        seals: ["S1"],
      },
      trailers: [],
      shipments: [
        {
          // Suffix decides the fixture outcome (H held, R rejected, else
          // accepted — `fixtureOutcomeFor`); "1" means accepted.
          controlNumber: "PFTRFIXTURE001",
          shipmentType: "regular_bill",
          cargoType: null,
          entryNumber: "ENT-1",
          entryPortCode: "3801",
          inBondEntryType: null,
          inBondDestinationPortCode: null,
          inBondNumber: null,
          loadingCountry: "CA",
          loadingProvince: "ON",
          loadingCity: "Hamilton",
          shipperName: "Acme Steel",
          shipperAddress: {
            line1: "1 Mill Rd",
            city: "Hamilton",
            region: "ON",
            postalCode: "L8L1A1",
            country: "CA",
          },
          consigneeName: "Depot Inc",
          consigneeAddress: {
            line1: "2 Depot Ave",
            city: "Detroit",
            region: "MI",
            postalCode: "48201",
            country: "US",
          },
          deliveryAddress: null,
          commodities: [
            {
              commodityDescription: "Steel Coil",
              hsCode: "7208.10",
              quantity: 2,
              quantityUnit: "Coil",
              weightKg: 1000,
              weightUnit: "KG",
              packagingType: "Skid",
              marksAndNumbers: "LOT-1",
              countryOfOrigin: "CA",
              valueAmount: 5000,
              valueCurrency: "USD",
              hazmat: [],
            },
          ],
        },
      ],
    };
  }

  beforeAll(async () => {
    savedApiKey = process.env.BORDERCONNECT_API_KEY;
    savedSuffix = process.env.BORDERCONNECT_API_URL_SUFFIX;
    // Fixture mode on BOTH sides is the whole point of this test.
    delete process.env.BORDERCONNECT_API_KEY;
    delete process.env.BORDERCONNECT_API_URL_SUFFIX;
    clearCustomsFixtureState();

    const [org] = await db
      .insert(organizations)
      .values({ name: `BC Fixture RT ${Date.now()}`, borderConnectCompanyKey: fxCompanyKey })
      .returning({ id: organizations.id });
    fxOrgId = org!.id;

    const [m] = await db
      .insert(movements)
      .values({
        organizationId: fxOrgId,
        regime: "ACE",
        movementNumber: fxMovementNumber,
        status: "sent",
      })
      .returning({ id: movements.id });
    fxMovementId = m!.id;

    await db.insert(schema.integrationConfigs).values({
      organizationId: fxOrgId,
      provider: "cbp_ace",
      environment: "sandbox",
      status: "active",
      mode: "border_connect",
      baseUrl: null,
      settings: {},
    });
  });

  afterAll(async () => {
    if (savedApiKey !== undefined) process.env.BORDERCONNECT_API_KEY = savedApiKey;
    if (savedSuffix !== undefined) process.env.BORDERCONNECT_API_URL_SUFFIX = savedSuffix;
    clearCustomsFixtureState();
    await withServiceRole(db, (tx) =>
      tx.delete(customsInbox).where(eq(customsInbox.companyKey, fxCompanyKey)),
    );
    await db.delete(organizations).where(eq(organizations.id, fxOrgId));
  });

  it("transmits through the org's own client and the drain's fixture fallback moves the movement to accepted", async () => {
    const { client } = await withServiceRole(db, (tx) => customsClientFor(tx, fxOrgId, "ACE"));
    expect(client.mode).toBe("border_connect");
    expect((client as unknown as { live: boolean }).live).toBe(false);

    const correlationId = `fx-corr-${Date.now()}`;
    const ack = await client.transmit(buildManifest(makeAceSource()), { correlationId });

    // The row `transmitMovement` would have written; the drain routes the
    // API_RESPONSE by it (sendId → correlation_id) and the ACE_RESPONSE by
    // reference_number.
    await db.insert(customsSubmissions).values({
      organizationId: fxOrgId,
      movementId: fxMovementId,
      kind: "original",
      provider: "cbp_ace",
      mode: "border_connect",
      referenceNumber: ack.referenceNumber,
      correlationId,
      status: "sent",
    });

    // No transport injected: `resolveTransport`'s own fixture fallback has to
    // find what the client above enqueued. This is the assertion that failed
    // before the tenant keys were aligned — `received` was 0.
    const result = await drainBorderConnectInbox(db);
    expect(result.received).toBeGreaterThanOrEqual(2);

    const [after] = await db.select().from(movements).where(eq(movements.id, fxMovementId));
    expect(after?.status).toBe("accepted");
  });
});

/**
 * Finding N1 / M1 / M2 of the final whole-branch review: row-level locking,
 * the RNS eligibility filter in the single-candidate case, and clearing a
 * stale `processing_error` on a successful retry.
 */
describe("processInboxRow — concurrency, eligibility and retry bookkeeping", () => {
  const { shipments, parsRnsEvents } = schema;
  let lockOrgId: string;
  let lockShipmentId: string;
  let lockControlNumber: string;
  let aceOrgId: string;
  let aceControlNumber: string;
  const strayInboxIds: number[] = [];

  beforeAll(async () => {
    const [org] = await db
      .insert(organizations)
      .values({ name: `BC Lock ${Date.now()}` })
      .returning({ id: organizations.id });
    lockOrgId = org!.id;

    const [m] = await db
      .insert(movements)
      .values({
        organizationId: lockOrgId,
        regime: "ACI",
        movementNumber: `BC-LOCK-${Date.now()}`,
        status: "draft",
      })
      .returning({ id: movements.id });

    const [s] = await withServiceRole(db, (tx) =>
      tx
        .insert(shipments)
        .values({
          organizationId: lockOrgId,
          movementId: m!.id,
          regime: "ACI",
          carrierCode: "7ELU",
          cargoType: "regular",
          controlReference: `LOCK${Date.now()}`.slice(0, 20),
          isPars: true,
        })
        .returning({ id: shipments.id, controlNumber: shipments.controlNumber }),
    );
    lockShipmentId = s!.id;
    lockControlNumber = s!.controlNumber;
    await db.update(movements).set({ status: "sent" }).where(eq(movements.id, m!.id));
    await db.update(movements).set({ status: "accepted" }).where(eq(movements.id, m!.id));
    await db.update(shipments).set({ status: "accepted" }).where(eq(shipments.id, lockShipmentId));

    // An ACE movement + shipment: the *only* global holder of its control
    // number, but the wrong regime for an RNS release (M1).
    const [aceOrg] = await db
      .insert(organizations)
      .values({ name: `BC ACE RNS ${Date.now()}` })
      .returning({ id: organizations.id });
    aceOrgId = aceOrg!.id;
    const [aceMovement] = await db
      .insert(movements)
      .values({
        organizationId: aceOrgId,
        regime: "ACE",
        movementNumber: `BC-ACE-${Date.now()}`,
        status: "draft",
      })
      .returning({ id: movements.id });
    const [aceShipment] = await withServiceRole(db, (tx) =>
      tx
        .insert(shipments)
        .values({
          organizationId: aceOrgId,
          movementId: aceMovement!.id,
          regime: "ACE",
          carrierCode: "7ELU",
          // ACE files a shipment type, ACI a cargo type — never both
          // (`shipments_regime_type_check`, migration 0019).
          shipmentType: "regular_bill",
          controlReference: `ACER${Date.now()}`.slice(0, 20),
          isPars: false,
        })
        .returning({ controlNumber: shipments.controlNumber }),
    );
    aceControlNumber = aceShipment!.controlNumber;
    await db.update(movements).set({ status: "sent" }).where(eq(movements.id, aceMovement!.id));
  });

  afterAll(async () => {
    // `pars_rns_events` is append-only (0027's `reject_modification` fires on
    // DELETE too, including via the org's own cascade), so the orgs are left
    // behind like the RNS suite above — `pnpm db:reset` cleans them wholesale.
    if (strayInboxIds.length > 0) {
      await withServiceRole(db, (tx) =>
        tx.delete(customsInbox).where(inArray(customsInbox.id, strayInboxIds)),
      );
    }
  });

  async function storeOne(message: Record<string, unknown>): Promise<number> {
    await withServiceRole(db, (tx) => storeInboundMessages(tx, [message]));
    const [row] = await withServiceRole(db, (tx) =>
      tx
        .select({ id: customsInbox.id })
        .from(customsInbox)
        .orderBy(desc(customsInbox.id))
        .limit(1),
    );
    strayInboxIds.push(row!.id);
    return row!.id;
  }

  function rnsMessage(cargoControlNumber: string, releaseCode = "4"): Record<string, unknown> {
    return {
      data: "RNS_SHIPMENT",
      cargoControlNumber,
      transactionNumber: `${Date.now()}`.slice(0, 14),
      releaseOffice: { number: "0470", name: "Test Office" },
      status: {
        dateTime: "2026-09-12 10:00:00",
        releaseCode: { number: releaseCode, shortName: "Released", longName: "Goods Released" },
      },
    };
  }

  it("two concurrent processInboxRow calls on the same row produce exactly one pars_rns_events insert", async () => {
    const rowId = await storeOne(rnsMessage(lockControlNumber));

    // Both calls race for the row's `for update skip locked` lock: the loser
    // either skips it (still locked) or finds it already processed. Without
    // the lock both could route the same message and write the audit row
    // twice — `applyTransition`'s compare-and-swap only guards a duplicate
    // *status* change, never a duplicate event-log write.
    const outcomes = await Promise.all([processInboxRow(db, rowId), processInboxRow(db, rowId)]);
    const kinds = outcomes.map((o) => o.outcome).sort();
    expect(kinds).toEqual(["ignored", "rns"]);
    expect(outcomes.find((o) => o.outcome === "ignored")?.detail).toMatch(
      /locked by another worker|already processed/,
    );

    const rnsRows = await withServiceRole(db, (tx) =>
      tx.select().from(parsRnsEvents).where(eq(parsRnsEvents.shipmentId, lockShipmentId)),
    );
    expect(rnsRows).toHaveLength(1);
  });

  it("a single global CCN match on an ACE shipment is unroutable, not silently routed", async () => {
    // Exactly one shipment in the whole database carries this control number,
    // so the old `candidates.length <= 1` short-circuit routed it — even
    // though RNS is CBSA's system and an ACE shipment can never be
    // RNS-released.
    const rowId = await storeOne(rnsMessage(aceControlNumber));
    const outcome = await processInboxRow(db, rowId);
    expect(outcome).toMatchObject({ outcome: "unroutable", detail: "unknown CCN" });

    const [row] = await withServiceRole(db, (tx) =>
      tx.select().from(customsInbox).where(eq(customsInbox.id, rowId)),
    );
    expect(row?.processingError).toBe("unknown CCN");
  });

  it("a successful retry clears the stale processing_error left by the failed attempt", async () => {
    // The state a throw leaves behind: `processing_error` stamped with the
    // attempt prefix, `processed_at` still null so the next drain retries.
    const alertRowId = await storeOne({
      data: "SYSTEM_ALERT",
      message: `Retry bookkeeping ${Date.now()}`,
    });
    await withServiceRole(db, (tx) =>
      tx
        .update(customsInbox)
        .set({ processingError: "attempt=1: connection terminated unexpectedly" })
        .where(eq(customsInbox.id, alertRowId)),
    );

    const outcome = await processInboxRow(db, alertRowId);
    expect(outcome.outcome).toBe("alert");

    const [row] = await withServiceRole(db, (tx) =>
      tx.select().from(customsInbox).where(eq(customsInbox.id, alertRowId)),
    );
    expect(row?.processedAt).not.toBeNull();
    // Before the fix this still read "attempt=1: …" in the Settings inbox list.
    expect(row?.processingError).toBeNull();
  });
});

describe("customs.borderconnect_drain job dispatch", () => {
  // The handler resolves its own transport from the environment, and this
  // suite is routinely run after `source .env.local` (which carries the real
  // BORDERCONNECT_API_KEY). `GET /api/receive` is pop-on-read with no replay,
  // so letting the handler go live here would silently destroy real messages —
  // force the in-process fixture queue for the duration of this test.
  let savedApiKey: string | undefined;
  let savedSuffix: string | undefined;
  beforeAll(() => {
    savedApiKey = process.env.BORDERCONNECT_API_KEY;
    savedSuffix = process.env.BORDERCONNECT_API_URL_SUFFIX;
    delete process.env.BORDERCONNECT_API_KEY;
    delete process.env.BORDERCONNECT_API_URL_SUFFIX;
  });
  afterAll(() => {
    if (savedApiKey !== undefined) process.env.BORDERCONNECT_API_KEY = savedApiKey;
    if (savedSuffix !== undefined) process.env.BORDERCONNECT_API_URL_SUFFIX = savedSuffix;
  });

  it("is a detached handler, and an org-null job is claimable", async () => {
    // Deliberately calls the handler directly rather than processDueJobs, like
    // jobs.integration.test.ts's billing.report_usage case: this suite and
    // packages/db's run in parallel and would otherwise race the shared
    // queue's SKIP LOCKED claim.
    const { detachedJobHandlers, jobHandlers } = await import("./services/jobs");
    expect(jobHandlers["customs.borderconnect_drain"]).toBeUndefined();
    expect(detachedJobHandlers["customs.borderconnect_drain"]).toBeTypeOf("function");

    // "org-null job is claimable": background_jobs.organization_id accepts
    // null for this job type and the row inserts under the service role
    // (the RLS side of "nobody but service role enqueues this" is asserted
    // in packages/db/src/customs.integration.test.ts).
    const [job] = await withServiceRole(db, (tx) =>
      tx
        .insert(schema.backgroundJobs)
        .values({
          organizationId: null,
          jobType: "customs.borderconnect_drain",
          runAt: new Date(Date.now() - 60_000),
        })
        .returning(),
    );
    expect(job?.organizationId).toBeNull();
    try {
      const result = await detachedJobHandlers["customs.borderconnect_drain"]!(db, job!);
      expect(result).toMatchObject({ errors: 0 });
    } finally {
      await withServiceRole(db, (tx) =>
        tx.delete(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, job!.id)),
      );
    }
  });
});
