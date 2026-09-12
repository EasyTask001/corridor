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
import { createDb, eq, inArray, schema, withServiceRole } from "@corridor/db";
import type { BorderConnectTransport } from "@corridor/integrations";
import { drainBorderConnectInbox, storeInboundMessages } from "./services/borderconnect";

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

describe("customs.borderconnect_drain job dispatch", () => {
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
