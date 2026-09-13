import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

const conn = createDb(DB_URL, { max: 1 });

async function rejection(promise: Promise<unknown>) {
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

afterAll(async () => conn.sql.end());

describe("shipment broker integrity", () => {
  it("accepts broker/dual partners and rejects wrong-role or cross-tenant partners", async () => {
    const suffix = Date.now().toString(36);
    const [org] = await conn.sql<{ id: string }[]>`
      insert into public.organizations (name) values (${`Broker test ${suffix}`}) returning id`;
    const [otherOrg] = await conn.sql<{ id: string }[]>`
      insert into public.organizations (name) values (${`Broker other ${suffix}`}) returning id`;
    let shipmentId: string | undefined;
    try {
      const partnerRows = await conn.sql<{ id: string; type: string }[]>`
        insert into public.partners (organization_id, name, type) values
          (${org!.id}, 'Test Broker', 'broker'),
          (${org!.id}, 'Test Dual', 'both'),
          (${org!.id}, 'Test Shipper', 'shipper')
        returning id, type`;
      const brokerId = partnerRows.find((p) => p.type === "broker")!.id;
      const dualId = partnerRows.find((p) => p.type === "both")!.id;
      const shipperId = partnerRows.find((p) => p.type === "shipper")!.id;
      const [other] = await conn.sql<{ id: string }[]>`
        insert into public.partners (organization_id, name, type)
        values (${otherOrg!.id}, 'Other Broker', 'broker') returning id`;
      const ref = `BRK${suffix.toUpperCase()}`.slice(-20).padStart(4, "B");
      const [shipment] = await conn.sql<{ id: string; broker_id: string }[]>`
        insert into public.shipments
          (organization_id, regime, carrier_code, shipment_type, control_reference, broker_id)
        values
          (${org!.id}, 'ACE', 'TST1', 'regular_bill', ${ref}, ${brokerId})
        returning id, broker_id`;
      shipmentId = shipment!.id;
      expect(shipment!.broker_id).toBe(brokerId);

      const [dual] = await conn.sql<{ broker_id: string }[]>`
        update public.shipments set broker_id = ${dualId}
        where id = ${shipmentId} returning broker_id`;
      expect(dual!.broker_id).toBe(dualId);

      expect(
        await rejection(
          conn.sql`update public.shipments set broker_id = ${shipperId} where id = ${shipmentId}`,
        ),
      ).toMatch(/shipment broker must be a broker or dual-role partner/);
      expect(
        await rejection(
          conn.sql`update public.shipments set broker_id = ${other!.id} where id = ${shipmentId}`,
        ),
      ).toMatch(/shipment broker must be a broker or dual-role partner|shipments_broker_org_fkey/);
    } finally {
      await conn.sql`delete from public.organizations where id in (${org!.id}, ${otherOrg!.id})`;
    }
  });

  it("locks the selected partner while validating its role", async () => {
    const [fn] = await conn.sql<{ definition: string }[]>`
      select pg_get_functiondef('public.validate_shipment_broker_role()'::regprocedure) as definition`;
    expect(fn?.definition).toContain("for update");
  });
});
