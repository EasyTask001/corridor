/**
 * shipments.loaded_on — migration 0051.
 *
 *   * a trailer slot from a different movement (even the same org) is
 *     refused by shipments_loaded_on_guard(), the same way seals_limit()
 *     refuses a seal on a slot that is not on its own movement;
 *   * a trailer slot from a different organization is refused by the
 *     composite FK (shipments_loaded_on_slot_fkey), invisible under RLS the
 *     same way every other org-scoped composite key in this schema is
 *     (see tenant-integrity.integration.test.ts for the general assertion);
 *   * TRUCK cannot carry a trailer id (shipments_loaded_on_shape_check);
 *   * dropping the trailer, unassigning the shipment, or moving it to
 *     another movement all clear both columns rather than leaving a stale
 *     reference behind;
 *   * shipments_guard() still freezes the pair once the movement is sent.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/db test:integration
 */
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

const conn = createDb(DB_URL, { max: 2 });
const sql = conn.sql;

afterAll(async () => {
  await conn.sql.end();
});

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
      messages.push(cause.message);
    }
    return messages.join(" | ");
  }
  throw new Error("expected rejection");
}

interface Fixture {
  orgId: string;
  movementId: string;
  slotId: string;
  shipmentId: string;
}

/** One org, one draft ACE movement, one trailer hitched to it (slot), and one
 * shipment assigned to that movement and loaded on that slot. */
async function makeFixture(suffix: string, orgIdOverride?: string): Promise<Fixture> {
  let orgId = orgIdOverride;
  if (!orgId) {
    const [org] = await sql<{ id: string }[]>`
      insert into public.organizations (name) values (${`LoadedOn test ${suffix}`}) returning id`;
    orgId = org!.id;
  }
  const [trailer] = await sql<{ id: string }[]>`
    insert into public.trailers (organization_id, unit_number, plate_number, plate_jurisdiction)
    values (${orgId}, ${`TR-${suffix}`}, ${`PLT${suffix}`}, 'MB')
    returning id`;
  const [movement] = await sql<{ id: string }[]>`
    insert into public.movements (organization_id, regime, movement_number)
    values (${orgId}, 'ACE', ${`MV-${suffix}`})
    returning id`;
  const [slot] = await sql<{ id: string }[]>`
    insert into public.movement_trailers (organization_id, movement_id, trailer_id)
    values (${orgId}, ${movement!.id}, ${trailer!.id})
    returning id`;
  // control_reference must match ^[A-Z0-9]{4,20}$ — strip the "-foreign"-style
  // suffixes used by cross-org tests and uppercase what's left.
  const controlReference = `REF${suffix.replace(/[^a-z0-9]/gi, "").toUpperCase()}`.slice(0, 20);
  const [shipment] = await sql<{ id: string }[]>`
    insert into public.shipments
      (organization_id, regime, movement_id, carrier_code, shipment_type, control_reference,
       loaded_on_type, loaded_on_movement_trailer_id)
    values
      (${orgId}, 'ACE', ${movement!.id}, 'TST1', 'regular_bill', ${controlReference},
       'TRAILER', ${slot!.id})
    returning id`;
  return { orgId, movementId: movement!.id, slotId: slot!.id, shipmentId: shipment!.id };
}

async function loadedOnOf(shipmentId: string) {
  const [row] = await sql<{ loaded_on_type: string | null; loaded_on_movement_trailer_id: string | null }[]>`
    select loaded_on_type, loaded_on_movement_trailer_id from public.shipments where id = ${shipmentId}`;
  return row!;
}

describe("shipments.loaded_on (0051)", () => {
  it("rejects a trailer slot from a different movement of the same org", async () => {
    const suffix = Date.now().toString(36) + "a";
    const f = await makeFixture(suffix);
    try {
      // A second, unrelated movement in the same org with its own slot.
      const [otherMovement] = await sql<{ id: string }[]>`
        insert into public.movements (organization_id, regime, movement_number)
        values (${f.orgId}, 'ACE', ${`MV-${suffix}-2`}) returning id`;
      const [otherTrailer] = await sql<{ id: string }[]>`
        insert into public.trailers (organization_id, unit_number, plate_number, plate_jurisdiction)
        values (${f.orgId}, ${`TR-${suffix}-2`}, ${`PLT${suffix}2`}, 'MB') returning id`;
      const [otherSlot] = await sql<{ id: string }[]>`
        insert into public.movement_trailers (organization_id, movement_id, trailer_id)
        values (${f.orgId}, ${otherMovement!.id}, ${otherTrailer!.id}) returning id`;

      const msg = await rejection(sql`
        update public.shipments set loaded_on_movement_trailer_id = ${otherSlot!.id}
        where id = ${f.shipmentId}`);
      expect(msg).toMatch(/loaded on a trailer that is not on this movement/);
    } finally {
      await sql`delete from public.organizations where id = ${f.orgId}`;
    }
  });

  it("rejects a trailer slot from a different organization", async () => {
    const suffix = Date.now().toString(36) + "b";
    const f = await makeFixture(suffix);
    const foreign = await makeFixture(suffix + "foreign");
    try {
      // shipments_loaded_on_guard's same-movement check runs before the
      // composite FK is evaluated, so it is the one that actually rejects
      // this write (a foreign org's slot can never share this shipment's
      // movement_id) — the FK is defence in depth if the trigger is ever
      // bypassed. Same two-message pattern as shipment-broker.integration.test.ts.
      const msg = await rejection(sql`
        update public.shipments set loaded_on_movement_trailer_id = ${foreign.slotId}
        where id = ${f.shipmentId}`);
      expect(msg).toMatch(/not on this movement|shipments_loaded_on_slot_fkey/);
    } finally {
      await sql`delete from public.organizations where id in (${f.orgId}, ${foreign.orgId})`;
    }
  });

  it("rejects TRUCK carrying a trailer id (shape check)", async () => {
    const suffix = Date.now().toString(36) + "c";
    const f = await makeFixture(suffix);
    try {
      const msg = await rejection(sql`
        update public.shipments set loaded_on_type = 'TRUCK'
        where id = ${f.shipmentId}`);
      expect(msg).toMatch(/shipments_loaded_on_shape_check/);
    } finally {
      await sql`delete from public.organizations where id = ${f.orgId}`;
    }
  });

  it("dropping the trailer slot clears both columns", async () => {
    const suffix = Date.now().toString(36) + "d";
    const f = await makeFixture(suffix);
    try {
      await sql`delete from public.movement_trailers where id = ${f.slotId}`;
      expect(await loadedOnOf(f.shipmentId)).toEqual({
        loaded_on_type: null,
        loaded_on_movement_trailer_id: null,
      });
    } finally {
      await sql`delete from public.organizations where id = ${f.orgId}`;
    }
  });

  it("unassigning the shipment clears both columns", async () => {
    const suffix = Date.now().toString(36) + "e";
    const f = await makeFixture(suffix);
    try {
      await sql`update public.shipments set movement_id = null where id = ${f.shipmentId}`;
      expect(await loadedOnOf(f.shipmentId)).toEqual({
        loaded_on_type: null,
        loaded_on_movement_trailer_id: null,
      });
    } finally {
      await sql`delete from public.organizations where id = ${f.orgId}`;
    }
  });

  it("re-assigning to another movement clears both columns", async () => {
    const suffix = Date.now().toString(36) + "f";
    const f = await makeFixture(suffix);
    try {
      const [otherMovement] = await sql<{ id: string }[]>`
        insert into public.movements (organization_id, regime, movement_number)
        values (${f.orgId}, 'ACE', ${`MV-${suffix}-2`}) returning id`;
      await sql`update public.shipments set movement_id = ${otherMovement!.id} where id = ${f.shipmentId}`;
      expect(await loadedOnOf(f.shipmentId)).toEqual({
        loaded_on_type: null,
        loaded_on_movement_trailer_id: null,
      });
    } finally {
      await sql`delete from public.organizations where id = ${f.orgId}`;
    }
  });

  it("freezes loaded_on once the movement is sent", async () => {
    const suffix = Date.now().toString(36) + "g";
    const f = await makeFixture(suffix);
    try {
      await sql`update public.movements set status = 'sent' where id = ${f.movementId}`;
      const msg = await rejection(sql`
        update public.shipments set loaded_on_type = 'TRUCK', loaded_on_movement_trailer_id = null
        where id = ${f.shipmentId}`);
      expect(msg).toMatch(/movement is not editable in status sent/);
    } finally {
      await sql`delete from public.organizations where id = ${f.orgId}`;
    }
  });

  it("deleting a draft movement detaches the shipment and clears its placement", async () => {
    const suffix = Date.now().toString(36) + "h";
    const f = await makeFixture(suffix);
    try {
      await sql`delete from public.movements where id = ${f.movementId}`;
      const [row] = await sql<
        { movement_id: string | null; loaded_on_type: string | null; loaded_on_movement_trailer_id: string | null }[]
      >`select movement_id, loaded_on_type, loaded_on_movement_trailer_id
        from public.shipments where id = ${f.shipmentId}`;
      expect(row).toEqual({
        movement_id: null,
        loaded_on_type: null,
        loaded_on_movement_trailer_id: null,
      });
    } finally {
      await sql`delete from public.organizations where id = ${f.orgId}`;
    }
  });
});
