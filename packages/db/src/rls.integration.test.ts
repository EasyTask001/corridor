/**
 * RLS-accurate integration tests against a local Supabase instance.
 *
 *   pnpm db:start && pnpm db:seed && pnpm --filter @corridor/db test:integration
 *
 * Each test opens a Drizzle transaction with `set local role authenticated`
 * and `request.jwt.claims` set to a real seeded user — exactly the path the
 * tRPC context uses — and asserts that Org A can never see Org B rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { withRls } from "./rls";
import { auditLog, organizationMembers, organizations, roles } from "./schema";

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
let readOnlyA: Actor;
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
  if (!m) throw new Error(`no membership for ${email}`);
  return { userId: user.id, email, orgId: m.orgId };
}

beforeAll(async () => {
  [ownerA, readOnlyA, ownerB] = await Promise.all([
    actorFor("owner@pathfinder.demo"),
    actorFor("readonly@pathfinder.demo"),
    actorFor("owner@northbound.demo"),
  ]);
  expect(ownerA.orgId).not.toBe(ownerB.orgId);
});

afterAll(async () => {
  await conn.sql.end();
});

const as = (a: Actor) => ({ sub: a.userId, email: a.email });

/** Drizzle wraps driver errors ("Failed query: …"); the Postgres message lives in `cause`. */
async function expectRlsDenied(p: Promise<unknown>) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, "expected the query to be rejected").toBeDefined();
  const messages: string[] = [];
  for (let e = err; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join(" | ")).toMatch(/permission denied|row-level security/i);
}

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

describe("organizations RLS", () => {
  it("a member sees only their own organization", async () => {
    const rows = await withRls(db, as(ownerA), (tx) => tx.select().from(organizations));
    expect(rows.map((r) => r.id)).toEqual([ownerA.orgId]);
  });

  it("cross-tenant: Org A owner gets zero rows when filtering for Org B", async () => {
    const rows = await withRls(db, as(ownerA), (tx) =>
      tx.select().from(organizations).where(eq(organizations.id, ownerB.orgId)),
    );
    expect(rows).toHaveLength(0);
  });

  it("cross-tenant: Org A owner cannot update Org B", async () => {
    const updated = await withRls(db, as(ownerA), (tx) =>
      tx
        .update(organizations)
        .set({ legalName: "HACKED" })
        .where(eq(organizations.id, ownerB.orgId))
        .returning({ id: organizations.id }),
    );
    expect(updated).toHaveLength(0);
  });

  it("read-only member cannot update their own organization (permission-gated policy)", async () => {
    const updated = await withRls(db, as(readOnlyA), (tx) =>
      tx
        .update(organizations)
        .set({ legalName: "nope" })
        .where(eq(organizations.id, readOnlyA.orgId))
        .returning({ id: organizations.id }),
    );
    expect(updated).toHaveLength(0);
  });

  it("owner can update their own organization", async () => {
    const updated = await withRls(db, as(ownerA), (tx) =>
      tx
        .update(organizations)
        .set({ legalName: "PATHFINDER TRANS INC" })
        .where(eq(organizations.id, ownerA.orgId))
        .returning({ id: organizations.id }),
    );
    expect(updated).toHaveLength(1);
  });

  it("direct insert into organizations is blocked for authenticated (must use RPC)", async () => {
    await expectRlsDenied(
      withRls(db, as(ownerA), (tx) =>
        tx.insert(organizations).values({ name: "Sneaky Org" }).returning(),
      ),
    );
  });
});

describe("organization_members RLS", () => {
  it("Org A member cannot list Org B roster", async () => {
    const rows = await withRls(db, as(ownerA), (tx) =>
      tx
        .select()
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, ownerB.orgId)),
    );
    expect(rows).toHaveLength(0);
  });

  it("read-only member cannot invite (organization.members.manage)", async () => {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "Read-Only"));
    await expectRlsDenied(
      withRls(db, as(readOnlyA), (tx) =>
        tx
          .insert(organizationMembers)
          .values({
            organizationId: readOnlyA.orgId,
            roleId: role!.id,
            status: "invited",
            invitedEmail: "sneaky@example.test",
          })
          .returning(),
      ),
    );
  });

  it("owner cannot invite into another org even with manage permission at home", async () => {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "Read-Only"));
    await expectRlsDenied(
      withRls(db, as(ownerA), (tx) =>
        tx
          .insert(organizationMembers)
          .values({
            organizationId: ownerB.orgId,
            roleId: role!.id,
            status: "invited",
            invitedEmail: "sneaky@example.test",
          })
          .returning(),
      ),
    );
  });

  it("cannot assign another organization's custom role", async () => {
    const [foreignRole] = await db
      .insert(roles)
      .values({ organizationId: ownerB.orgId, name: `Foreign Role ${Date.now()}` })
      .returning({ id: roles.id });
    const [target] = await db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, readOnlyA.userId));

    try {
      const message = await rejection(
        withRls(db, as(ownerA), (tx) =>
          tx
            .update(organizationMembers)
            .set({ roleId: foreignRole!.id })
            .where(eq(organizationMembers.id, target!.id)),
        ),
      );
      expect(message).toMatch(/does not belong to organization/i);
    } finally {
      await db.delete(roles).where(eq(roles.id, foreignRole!.id));
    }
  });
});

describe("helper functions", () => {
  it("current_user_permissions returns the seeded grant set", async () => {
    const owner = await withRls(db, as(ownerA), async (tx) => {
      const r = await tx.execute<{ key: string }>(
        sql`select * from public.current_user_permissions(${ownerA.orgId}) as key`,
      );
      return r.map((x) => x.key);
    });
    expect(owner).toContain("movement.transmit_to_customs");
    expect(owner).toContain("billing.manage");

    const ro = await withRls(db, as(readOnlyA), async (tx) => {
      const r = await tx.execute<{ key: string }>(
        sql`select * from public.current_user_permissions(${readOnlyA.orgId}) as key`,
      );
      return r.map((x) => x.key);
    });
    expect(ro).not.toContain("movement.transmit_to_customs");
    expect(ro.every((k) => k.endsWith(".read"))).toBe(true);
  });

  it("permissions for a foreign org are empty", async () => {
    const r = await withRls(db, as(ownerA), (tx) =>
      tx.execute<{ key: string }>(
        sql`select * from public.current_user_permissions(${ownerB.orgId}) as key`,
      ),
    );
    expect(r).toHaveLength(0);
  });

  it("role is reset after the transaction (pool safety)", async () => {
    await withRls(db, as(ownerA), (tx) => tx.select().from(organizations));
    const r = await db.execute<{ current_user: string }>(sql`select current_user`);
    expect(r[0]?.current_user).not.toBe("authenticated");
  });
});

describe("audit log RLS", () => {
  it("keeps audit events inside their organization", async () => {
    const marker = `rls-audit-${Date.now()}`;
    await withRls(db, as(ownerA), (tx) =>
      tx.execute(
        sql`select public.log_audit(${ownerA.orgId}::uuid, 'test.audit', 'test', ${marker}, null, null)`,
      ),
    );
    try {
      const own = await withRls(db, as(ownerA), (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.entityId, marker)),
      );
      const foreign = await withRls(db, as(ownerB), (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.entityId, marker)),
      );
      expect(own).toHaveLength(1);
      expect(foreign).toHaveLength(0);
    } finally {
      await db.delete(auditLog).where(eq(auditLog.entityId, marker));
    }
  });

  it("rejects direct authenticated writes to the append-only log", async () => {
    await expectRlsDenied(
      withRls(db, as(ownerA), (tx) =>
        tx.insert(auditLog).values({
          organizationId: ownerA.orgId,
          action: "test.direct_write",
          entityType: "test",
        }),
      ),
    );
  });
});
