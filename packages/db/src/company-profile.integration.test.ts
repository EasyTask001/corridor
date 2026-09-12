/**
 * SMS channel, driver notification detail, company profile — migration 0025.
 *
 *   * a notification rule may select the `sms` channel;
 *   * shipments_control_number() prefixes PARS on ACI PARS shipments when the
 *     organization files that way — and only then;
 *   * dispatch_emails is capped at five;
 *   * a transmitter may enqueue driver.notify.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/db test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls } from "./rls";
import {
  backgroundJobs,
  notificationRules,
  organizationMembers,
  organizations,
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
let ownerA: Actor;
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
  [ownerA, dispatcherA] = await Promise.all([
    actorFor("owner@pathfinder.demo"),
    actorFor("dispatch@pathfinder.demo"),
  ]);
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

describe("notification rules with sms (0025)", () => {
  it("a member may route an event to SMS", async () => {
    const [rule] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(notificationRules)
        .values({
          organizationId: dispatcherA.orgId,
          userId: dispatcherA.userId,
          eventType: "shipment.entry_on_file",
          enabled: true,
          channel: ["in_app", "sms"],
        })
        .onConflictDoUpdate({
          target: [
            notificationRules.organizationId,
            notificationRules.userId,
            notificationRules.eventType,
          ],
          set: { channel: ["in_app", "sms"] },
        })
        .returning(),
    );
    expect(rule?.channel).toEqual(["in_app", "sms"]);
    await db.delete(notificationRules).where(eq(notificationRules.id, rule!.id));
  });
});

describe("shipments_control_number() with PARS (0025)", () => {
  const ref = () => `T${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)}`;
  const insert = (isPars: boolean, controlReference: string) =>
    withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(shipments)
        .values({
          organizationId: dispatcherA.orgId,
          regime: "ACI",
          movementId: null,
          carrierCode: "7ELU",
          cargoType: "regular",
          controlReference,
          isPars,
        })
        .returning({ id: shipments.id, controlNumber: shipments.controlNumber }),
    );

  it("prefixes PARS only when the organization files that way and the shipment is PARS", async () => {
    const setFlag = (on: boolean) =>
      db
        .update(organizations)
        .set({ includeParsInCargoNumbers: on })
        .where(eq(organizations.id, dispatcherA.orgId));
    const ids: string[] = [];
    try {
      await setFlag(false);
      const r1 = ref();
      const [plain] = await insert(true, r1);
      ids.push(plain!.id);
      expect(plain?.controlNumber).toBe(`7ELU${r1}`);

      await setFlag(true);
      const r2 = ref();
      const [pars] = await insert(true, r2);
      ids.push(pars!.id);
      expect(pars?.controlNumber).toBe(`7ELUPARS${r2}`);

      const r3 = ref();
      const [notPars] = await insert(false, r3);
      ids.push(notPars!.id);
      expect(notPars?.controlNumber).toBe(`7ELU${r3}`);

      // A reference already carrying the prefix is not doubled.
      const [already] = await insert(true, `PARS${r3}`);
      ids.push(already!.id);
      expect(already?.controlNumber).toBe(`7ELUPARS${r3}`);
    } finally {
      await setFlag(false);
      for (const id of ids) await db.delete(shipments).where(eq(shipments.id, id));
    }
  });
});

describe("company profile (0025)", () => {
  it("caps dispatch_emails at five and keeps the other columns writable by organization.manage", async () => {
    const five = Array.from({ length: 5 }, (_, i) => `d${i}@pathfinder.demo`);
    const [ok] = await withRls(db, as(ownerA), (tx) =>
      tx
        .update(organizations)
        .set({ dispatchEmails: five, timezone: "America/Vancouver" })
        .where(eq(organizations.id, ownerA.orgId))
        .returning({
          dispatchEmails: organizations.dispatchEmails,
          timezone: organizations.timezone,
        }),
    );
    expect(ok).toEqual({ dispatchEmails: five, timezone: "America/Vancouver" });
    const msg = await rejection(
      withRls(db, as(ownerA), (tx) =>
        tx
          .update(organizations)
          .set({ dispatchEmails: [...five, "six@pathfinder.demo"] })
          .where(eq(organizations.id, ownerA.orgId))
          .returning(),
      ),
    );
    expect(msg).toMatch(/organizations_dispatch_emails_check/);
    await db
      .update(organizations)
      .set({
        dispatchEmails: ["dispatch@pathfinder.demo", "ops@pathfinder.demo"],
        timezone: "America/Toronto",
      })
      .where(eq(organizations.id, ownerA.orgId));
  });

  it("a transmitter may enqueue driver.notify", async () => {
    const [job] = await withRls(db, as(dispatcherA), (tx) =>
      tx
        .insert(backgroundJobs)
        .values({
          organizationId: dispatcherA.orgId,
          jobType: "driver.notify",
          payload: { movementId: "00000000-0000-4000-8000-000000000000", trigger: "accepted" },
          runAt: new Date(Date.now() + 3_600_000),
        })
        .returning({ id: backgroundJobs.id }),
    );
    expect(job?.id).toBeTypeOf("number");
    await db.delete(backgroundJobs).where(and(eq(backgroundJobs.id, job!.id), sql`true`));
  });
});
