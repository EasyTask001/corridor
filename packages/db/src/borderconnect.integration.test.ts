/**
 * BorderConnect schema — migration 0047: `mode` widened to `border_connect`
 * on integration_configs / customs_submissions, organizations.
 * border_connect_company_key (unique per org), trucks.truck_type
 * (BorderConnect/CBP conveyance type), the shared customs_inbox table, and
 * the background_jobs_insert rebuild that allow-lists
 * customs.borderconnect_drain to the service role only.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/db test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq, inArray, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls, withServiceRole } from "./rls";
import {
  backgroundJobs,
  customsInbox,
  customsSubmissions,
  integrationConfigs,
  movements,
  organizationMembers,
  organizations,
  trucks,
} from "./schema";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const conn = createDb(DB_URL, { max: 4 });
const db = conn.db;

interface Actor {
  userId: string;
  email: string;
  orgId: string;
}
let ownerA: Actor;
let ownerB: Actor;

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
  [ownerA, ownerB] = await Promise.all([
    actorFor("owner@pathfinder.demo"),
    actorFor("owner@northbound.demo"),
  ]);
  expect(ownerA.orgId).not.toBe(ownerB.orgId);
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

async function createDraft(actor: Actor) {
  return withRls(db, as(actor), async (tx) => {
    const numRows = await tx.execute<{ n: string }>(
      sql`select public.next_movement_number(${actor.orgId}::uuid, 'ACE') as n`,
    );
    const [m] = await tx
      .insert(movements)
      .values({
        organizationId: actor.orgId,
        regime: "ACE",
        movementNumber: numRows[0]!.n,
        createdBy: actor.userId,
      })
      .returning();
    return m!;
  });
}

describe("0047 borderconnect", () => {
  it("accepts mode = border_connect on integration_configs and customs_submissions", async () => {
    const [cfg] = await withRls(db, as(ownerA), (tx) =>
      tx
        .insert(integrationConfigs)
        .values({
          organizationId: ownerA.orgId,
          provider: "hts_tariff",
          mode: "border_connect",
        })
        .returning(),
    );
    expect(cfg?.mode).toBe("border_connect");

    const m = await createDraft(ownerA);
    try {
      const [sub] = await withRls(db, as(ownerA), (tx) =>
        tx
          .insert(customsSubmissions)
          .values({
            organizationId: ownerA.orgId,
            movementId: m.id,
            kind: "original",
            provider: "cbp_ace",
            mode: "border_connect",
          })
          .returning(),
      );
      expect(sub?.mode).toBe("border_connect");
    } finally {
      await db.delete(movements).where(eq(movements.id, m.id));
    }
    await db.delete(integrationConfigs).where(eq(integrationConfigs.id, cfg!.id));
  });

  it("rejects two organizations with the same border_connect_company_key", async () => {
    const key = `BC-DUP-${Date.now()}`;
    const [orgX, orgY] = await db
      .insert(organizations)
      .values([
        { name: `BC Key A ${Date.now()}` },
        { name: `BC Key B ${Date.now()}` },
      ])
      .returning({ id: organizations.id });
    try {
      await withServiceRole(db, (tx) =>
        tx
          .update(organizations)
          .set({ borderConnectCompanyKey: key })
          .where(eq(organizations.id, orgX!.id)),
      );
      const msg = await rejection(
        withServiceRole(db, (tx) =>
          tx
            .update(organizations)
            .set({ borderConnectCompanyKey: key })
            .where(eq(organizations.id, orgY!.id)),
        ),
      );
      expect(msg).toMatch(/duplicate key value violates unique constraint/);
    } finally {
      await db.delete(organizations).where(inArray(organizations.id, [orgX!.id, orgY!.id]));
    }
  });

  it("defaults trucks.truck_type to TR and rejects a non two-letter code", async () => {
    const tag = Date.now();
    const [truck] = await withRls(db, as(ownerA), (tx) =>
      tx
        .insert(trucks)
        .values({
          organizationId: ownerA.orgId,
          unitNumber: `T-BC-${tag}`,
          plateNumber: `PLT-BC-${tag}`,
          plateJurisdiction: "ON",
        })
        .returning(),
    );
    expect(truck?.truckType).toBe("TR");

    const msg = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .insert(trucks)
          .values({
            organizationId: ownerA.orgId,
            unitNumber: `T-BC-${tag}-bad`,
            plateNumber: `PLT-BC-${tag}-bad`,
            plateJurisdiction: "ON",
            truckType: "TRK",
          })
          .returning(),
      ),
    );
    expect(msg).toMatch(/violates check constraint/);

    await db.delete(trucks).where(eq(trucks.id, truck!.id));
  });

  describe("customs_inbox", () => {
    it("service role inserts, org A owner reads only rows routed to A, org B sees zero, authenticated insert is denied", async () => {
      const [rowA] = await withServiceRole(db, (tx) =>
        tx
          .insert(customsInbox)
          .values({
            organizationId: ownerA.orgId,
            dataType: "SYSTEM_ALERT",
            payload: { test: true },
            payloadSha256: `sha-a-${Date.now()}`,
          })
          .returning(),
      );
      try {
        const seenByA = await withRls(db, as(ownerA), (tx) =>
          tx.select().from(customsInbox).where(eq(customsInbox.id, rowA!.id)),
        );
        expect(seenByA).toHaveLength(1);

        const seenByB = await withRls(db, as(ownerB), (tx) =>
          tx.select().from(customsInbox).where(eq(customsInbox.id, rowA!.id)),
        );
        expect(seenByB).toHaveLength(0);
        const allForB = await withRls(db, as(ownerB), (tx) => tx.select().from(customsInbox));
        expect(allForB.every((r) => r.organizationId === ownerB.orgId)).toBe(true);

        const denied = await rejection(
          withRls(db, as(ownerA), (tx) =>
            tx
              .insert(customsInbox)
              .values({
                organizationId: ownerA.orgId,
                dataType: "SYSTEM_ALERT",
                payload: {},
                payloadSha256: `sha-denied-${Date.now()}`,
              })
              .returning(),
          ),
        );
        expect(denied).toMatch(/permission denied/i);
      } finally {
        await withServiceRole(db, (tx) =>
          tx.delete(customsInbox).where(eq(customsInbox.id, rowA!.id)),
        );
      }
    });

    it("rows with organization_id null are invisible to every tenant", async () => {
      const [row] = await withServiceRole(db, (tx) =>
        tx
          .insert(customsInbox)
          .values({
            organizationId: null,
            dataType: "RNS_SHIPMENT",
            payload: {},
            payloadSha256: `sha-null-${Date.now()}`,
          })
          .returning(),
      );
      try {
        const seenByA = await withRls(db, as(ownerA), (tx) =>
          tx.select().from(customsInbox).where(eq(customsInbox.id, row!.id)),
        );
        expect(seenByA).toHaveLength(0);
        const seenByB = await withRls(db, as(ownerB), (tx) =>
          tx.select().from(customsInbox).where(eq(customsInbox.id, row!.id)),
        );
        expect(seenByB).toHaveLength(0);
      } finally {
        await withServiceRole(db, (tx) =>
          tx.delete(customsInbox).where(eq(customsInbox.id, row!.id)),
        );
      }
    });
  });

  describe("background_jobs after 0047", () => {
    it("authenticated cannot enqueue customs.borderconnect_drain; service role can with organization_id null", async () => {
      const denied = await rejection(
        withRls(db, as(ownerA), (tx) =>
          tx
            .insert(backgroundJobs)
            .values({
              organizationId: ownerA.orgId,
              jobType: "customs.borderconnect_drain",
              payload: {},
            })
            .returning(),
        ),
      );
      expect(denied).toMatch(/row-level security/);

      const [job] = await withServiceRole(db, (tx) =>
        tx
          .insert(backgroundJobs)
          .values({
            organizationId: null,
            jobType: "customs.borderconnect_drain",
            payload: {},
          })
          .returning({ id: backgroundJobs.id }),
      );
      expect(job?.id).toBeTypeOf("number");
      await withServiceRole(db, (tx) =>
        tx.delete(backgroundJobs).where(eq(backgroundJobs.id, job!.id)),
      );
    });
  });
});
