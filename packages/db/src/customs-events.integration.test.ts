/**
 * Manifest flags, CBSA amendment reason codes and customs events — migration 0022.
 *
 *   * the ACI trip flags are refused on an ACE movement (check constraint);
 *   * an ACI amendment must carry a CBSA reason code, and may only point at a
 *     shipment riding that movement (movement_amendments_reason_guard);
 *   * `customs_event` rows are accepted on the append-only timeline;
 *   * a shipment's entry number may land after transmit (shipments_guard).
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/db test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls } from "./rls";
import {
  movementAmendments,
  movementEvents,
  movements,
  organizationMembers,
  shipments,
} from "./schema";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const conn = createDb(DB_URL, { max: 2 });
const db = conn.db;

interface Actor {
  userId: string;
  email: string;
  orgId: string;
}
let dispatcherA: Actor;

async function actorFor(email: string): Promise<Actor> {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY required");
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const user = data?.users.find((u) => u.email === email);
  if (!user) throw new Error(`seed user ${email} missing — run pnpm db:seed`);
  const [m] = await db
    .select({ orgId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, user.id))
    .limit(1);
  return { userId: user.id, email, orgId: m!.orgId };
}

beforeAll(async () => {
  dispatcherA = await actorFor("dispatch@pathfinder.demo");
});

afterAll(async () => {
  await conn.sql.end();
});

const as = (a: Actor) => ({ sub: a.userId, email: a.email });

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const messages: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = e.cause) messages.push(e.message);
    return messages.join(" | ");
  }
  throw new Error("expected rejection");
}

async function createDraft(actor: Actor, regime: "ACE" | "ACI") {
  return withRls(db, as(actor), async (tx) => {
    const numRows = await tx.execute<{ n: string }>(
      sql`select public.next_movement_number(${actor.orgId}::uuid, ${regime}) as n`,
    );
    const [m] = await tx
      .insert(movements)
      .values({
        organizationId: actor.orgId,
        regime,
        movementNumber: numRows[0]!.n,
        createdBy: actor.userId,
      })
      .returning();
    return m!;
  });
}

async function createShipment(actor: Actor, regime: "ACE" | "ACI", movementId: string | null) {
  return withRls(db, as(actor), async (tx) => {
    const [s] = await tx
      .insert(shipments)
      .values({
        organizationId: actor.orgId,
        regime,
        movementId,
        carrierCode: regime === "ACE" ? "PFTR" : "7ELU",
        ...(regime === "ACE"
          ? { shipmentType: "regular_bill" as const }
          : { cargoType: "regular" as const }),
        controlReference: `T${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)}`,
      })
      .returning();
    return s!;
  });
}

describe("manifest flags (0022)", () => {
  it("keeps the ACI trip flags off an ACE movement, and lets ACI set them", async () => {
    const ace = await createDraft(dispatcherA, "ACE");
    const aci = await createDraft(dispatcherA, "ACI");
    try {
      const msg = await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx.update(movements).set({ aciLvs: true }).where(eq(movements.id, ace.id)).returning(),
        ),
      );
      expect(msg).toMatch(/movements_aci_flags_check/);
      const [ok] = await withRls(db, as(dispatcherA), (tx) =>
        tx
          .update(movements)
          .set({ aciLvs: true, aciInTransit: true, iitIndicator: "iit_carrier_bond" })
          .where(eq(movements.id, aci.id))
          .returning(),
      );
      expect(ok).toMatchObject({
        aciLvs: true,
        aciInTransit: true,
        iitIndicator: "iit_carrier_bond",
      });
    } finally {
      await db.delete(movements).where(eq(movements.id, ace.id));
      await db.delete(movements).where(eq(movements.id, aci.id));
    }
  });

  it("a flag is manifest content: frozen once sent", async () => {
    const m = await createDraft(dispatcherA, "ACI");
    try {
      await withRls(db, as(dispatcherA), (tx) =>
        tx.update(movements).set({ status: "sent" }).where(eq(movements.id, m.id)),
      );
      const msg = await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx.update(movements).set({ aciPostal: true }).where(eq(movements.id, m.id)).returning(),
        ),
      );
      expect(msg).toMatch(/not editable in status sent/);
    } finally {
      await db.delete(movements).where(eq(movements.id, m.id));
    }
  });
});

describe("movement_amendments_reason_guard()", () => {
  it("an ACI amendment needs a CBSA reason code; ACE does not", async () => {
    const aci = await createDraft(dispatcherA, "ACI");
    const ace = await createDraft(dispatcherA, "ACE");
    try {
      const msg = await rejection(
        db
          .insert(movementAmendments)
          .values({
            movementId: aci.id,
            organizationId: dispatcherA.orgId,
            amendmentNumber: 1,
            reason: "no code",
          })
          .returning(),
      );
      expect(msg).toMatch(/requires a CBSA reason code/);
      const [withCode] = await db
        .insert(movementAmendments)
        .values({
          movementId: aci.id,
          organizationId: dispatcherA.orgId,
          amendmentNumber: 1,
          reason: "typo in plate",
          reasonCode: "40",
        })
        .returning();
      expect(withCode?.reasonCode).toBe("40");
      const bad = await rejection(
        db
          .insert(movementAmendments)
          .values({
            movementId: aci.id,
            organizationId: dispatcherA.orgId,
            amendmentNumber: 2,
            reason: "unknown code",
            reasonCode: "99" as never,
          })
          .returning(),
      );
      expect(bad).toMatch(/movement_amendments_reason_code_check/);
      const [ace1] = await db
        .insert(movementAmendments)
        .values({
          movementId: ace.id,
          organizationId: dispatcherA.orgId,
          amendmentNumber: 1,
          reason: "CBP needs no code",
        })
        .returning();
      expect(ace1?.reasonCode).toBeNull();
    } finally {
      await db.delete(movements).where(eq(movements.id, aci.id));
      await db.delete(movements).where(eq(movements.id, ace.id));
    }
  });

  it("an amendment may only point at a shipment on its own movement", async () => {
    const m = await createDraft(dispatcherA, "ACE");
    const other = await createDraft(dispatcherA, "ACE");
    const mine = await createShipment(dispatcherA, "ACE", m.id);
    const theirs = await createShipment(dispatcherA, "ACE", other.id);
    try {
      const msg = await rejection(
        db
          .insert(movementAmendments)
          .values({
            movementId: m.id,
            organizationId: dispatcherA.orgId,
            amendmentNumber: 1,
            reason: "wrong shipment",
            shipmentId: theirs.id,
          })
          .returning(),
      );
      expect(msg).toMatch(/amendment shipment is not on this movement/);
      const [ok] = await db
        .insert(movementAmendments)
        .values({
          movementId: m.id,
          organizationId: dispatcherA.orgId,
          amendmentNumber: 1,
          reason: "consignee corrected",
          reasonCode: "25",
          shipmentId: mine.id,
        })
        .returning();
      expect(ok?.shipmentId).toBe(mine.id);
    } finally {
      await db.delete(shipments).where(eq(shipments.id, mine.id));
      await db.delete(shipments).where(eq(shipments.id, theirs.id));
      await db.delete(movements).where(eq(movements.id, m.id));
      await db.delete(movements).where(eq(movements.id, other.id));
    }
  });
});

describe("customs events after transmit", () => {
  it("a customs_event lands on the timeline and the entry number on the shipment while sent", async () => {
    const m = await createDraft(dispatcherA, "ACE");
    const s = await createShipment(dispatcherA, "ACE", m.id);
    try {
      await withRls(db, as(dispatcherA), (tx) =>
        tx.update(movements).set({ status: "sent" }).where(eq(movements.id, m.id)),
      );
      const [ev] = await withRls(db, as(dispatcherA), (tx) =>
        tx
          .insert(movementEvents)
          .values({
            movementId: m.id,
            organizationId: dispatcherA.orgId,
            shipmentId: s.id,
            eventType: "customs_event",
            actorType: "customs_api",
            payload: { code: "entry_on_file", label: "Entry on file", entryNumber: "30012345678" },
          })
          .returning(),
      );
      expect(ev?.eventType).toBe("customs_event");
      // Entry data is customs-assigned, not frozen manifest content…
      const [entered] = await withRls(db, as(dispatcherA), (tx) =>
        tx
          .update(shipments)
          .set({ entryNumber: "30012345678", status: "accepted" })
          .where(eq(shipments.id, s.id))
          .returning(),
      );
      expect(entered?.entryNumber).toBe("30012345678");
      // …while the content itself stays frozen.
      const msg = await rejection(
        withRls(db, as(dispatcherA), (tx) =>
          tx.update(shipments).set({ notes: "edited" }).where(eq(shipments.id, s.id)).returning(),
        ),
      );
      expect(msg).toMatch(/not editable in status sent/);
    } finally {
      await db.delete(movements).where(eq(movements.id, m.id));
      await db.delete(shipments).where(eq(shipments.id, s.id));
    }
  });
});
