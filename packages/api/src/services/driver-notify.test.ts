/**
 * `driver.notify` against the in-memory fake DB: the sheet is rendered and
 * stored, dispatch and the person in charge are e-mailed, the opted-in driver
 * gets the entry numbers by SMS, and the delivery lands on the timeline.
 * Storage is stubbed (no Supabase here); the senders are injected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as PdfModule from "./pdf";
import { createFakeDb, TEST_ORG_ID, type Row } from "../test/mock-context";

const generateForMovement = vi.fn();
vi.mock("./pdf", async (importOriginal) => ({
  ...(await importOriginal<typeof PdfModule>()),
  generateForMovement: (...args: unknown[]) => generateForMovement(...args),
}));

const { runDriverNotify, entriesComplete } = await import("./driver-notify");

const MOVEMENT_ID = "44444444-4444-4444-8444-444444444444";
const DRIVER_ID = "55555555-5555-4555-8555-555555555555";

function rows(over: { smsOptIn?: boolean; dispatchEmails?: string[]; entry?: string | null } = {}): Record<string, Row[]> {
  return {
    organizations: [
      {
        id: TEST_ORG_ID,
        name: "Pathfinder Trans Inc",
        legalName: null,
        scacCode: "PFTR",
        usDotNumber: "1234567",
        filerCode: null,
        dispatchEmails: over.dispatchEmails ?? ["dispatch@pathfinder.demo"],
        simpleDriverSheet: false,
      },
    ],
    movements: [
      {
        id: MOVEMENT_ID,
        organizationId: TEST_ORG_ID,
        regime: "ACE",
        movementNumber: "ACE-26-00042",
        tripNumber: "TRIP-1042",
        status: "accepted",
        portId: null,
        customsReferenceNumber: "ACE-REF",
        isEmpty: false,
      },
    ],
    movementCrew: [
      {
        id: "c1",
        organizationId: TEST_ORG_ID,
        movementId: MOVEMENT_ID,
        driverId: DRIVER_ID,
        role: "person_in_charge",
        position: 1,
        firstName: "Gurpreet",
        lastName: "Singh",
        personType: "driver",
        status: "active",
      },
    ],
    drivers: [
      {
        id: DRIVER_ID,
        organizationId: TEST_ORG_ID,
        email: "gurpreet@pathfinder.demo",
        phone: "+1 905 555 0101",
        smsOptIn: over.smsOptIn ?? true,
        smsPhoneAce: "+1 905 555 0199",
        smsPhoneAci: null,
        emailDriverSheet: true,
      },
    ],
    driverDocuments: [],
    trucks: [],
    movementTrailers: [],
    equipmentPlates: [],
    shipments: [
      {
        id: "s1",
        organizationId: TEST_ORG_ID,
        movementId: MOVEMENT_ID,
        controlNumber: "PFTRPAPS00001",
        status: "accepted",
        entryNumber: over.entry === undefined ? "30012345678" : over.entry,
        entryPortCode: "3801",
      },
    ],
    commodities: [],
    commodityHazmat: [],
    seals: [],
    movementEvents: [],
    movementAmendments: [],
    integrationEvents: [],
  };
}

beforeEach(() => {
  generateForMovement.mockReset().mockResolvedValue({
    id: "doc-1",
    storagePath: "x/generated/y/driver_sheet.pdf",
    byteSize: 4321,
    signedUrl: "https://storage.example/driver_sheet.pdf?token=t",
  });
});

describe("runDriverNotify", () => {
  it("e-mails dispatch and the driver, texts the entry numbers, notes the delivery", async () => {
    const db = createFakeDb({ rows: rows(), sqlValues: { shipperName: null, consigneeName: null } });
    const email = vi.fn(async () => ({ mode: "mock" as const, id: null }));
    const sms = vi.fn(async () => ({ mode: "mock" as const, id: null }));
    const r = await runDriverNotify(
      db.tx,
      TEST_ORG_ID,
      { movementId: MOVEMENT_ID, trigger: "entries_complete" },
      { email, sms },
    );
    expect(generateForMovement).toHaveBeenCalledWith(expect.anything(), { orgId: TEST_ORG_ID, userId: null }, { movementId: MOVEMENT_ID, kind: "driver_sheet" });
    const sent = email.mock.calls.map((c) => (c as unknown as [{ to: string; text: string }])[0]);
    expect(sent.map((m) => m.to).sort()).toEqual(["dispatch@pathfinder.demo", "gurpreet@pathfinder.demo"]);
    expect(sent[0]?.text).toContain("PFTRPAPS00001: entry 30012345678 @ 3801");
    expect(sms).toHaveBeenCalledWith({
      to: "+1 905 555 0199",
      body: "TRIP-1042: PFTRPAPS00001: entry 30012345678 @ 3801",
    });
    expect(r).toMatchObject({ documentId: "doc-1", emailed: 2, emailFailed: 0, sms: { ok: true, mode: "mock" } });
    const note = db.table("movementEvents").find((e) => e.eventType === "note");
    expect(note?.actorType).toBe("system");
    expect((note?.payload as { body: string }).body).toMatch(/e-mailed to .*SMS to \+1 905 555 0199/);
    expect(db.table("integrationEvents").map((e) => e.provider).sort()).toEqual(["email", "email", "sms"]);
  });

  it("sends no SMS without opt-in or before an entry exists, and still reports a failed e-mail", async () => {
    const db = createFakeDb({ rows: rows({ smsOptIn: false, entry: null }), sqlValues: {} });
    const email = vi.fn(async () => ({ mode: "resend" as const, id: null, error: "bounced" }));
    const sms = vi.fn();
    const r = await runDriverNotify(db.tx, TEST_ORG_ID, { movementId: MOVEMENT_ID, trigger: "accepted" }, { email, sms });
    expect(sms).not.toHaveBeenCalled();
    expect(r).toMatchObject({ emailed: 0, emailFailed: 2, sms: null });
    expect((db.table("movementEvents")[0]?.payload as { body: string }).body).toContain("e-mail failed");
  });

  it("entriesComplete needs at least one shipment and an entry on each", () => {
    expect(entriesComplete([])).toBe(false);
    expect(entriesComplete([{ entryNumber: "1" }, { entryNumber: null }])).toBe(false);
    expect(entriesComplete([{ entryNumber: "1" }, { entryNumber: "2" }])).toBe(true);
  });
});
