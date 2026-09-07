/**
 * Notification delivery against the real database — the parts that are all
 * SQL-shaped and therefore invisible to the unit tests.
 *
 * `movement.assigned` is the one event a Driver-Portal member can receive, and
 * it is *targeted*: the driver → auth user link, the per-user rule lookup and
 * the service-role insert into `notifications` (a table with no authenticated
 * insert policy at all) are all exercised here. The push path is covered on
 * both shapes, because `push_tokens_for` is executable by `service_role` only.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/api test:integration
 */
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, and, eq, schema, withRls, withServiceRole } from "@corridor/db";
import { createClient } from "@supabase/supabase-js";
import { notifyOrganization, notifyUser, resolveDriverAssignment } from "./services/notifications";
import { jobHandlers } from "./services/jobs";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const conn = createDb(DB_URL, { max: 4 });
const db = conn.db;
const { backgroundJobs, drivers, movements, notificationRules, notifications, userDevices } =
  schema;

let orgId: string;
let driverUserId: string;
let dispatcherUserId: string;
/** The seeded driver row that is linked to an auth user. */
let linkedDriverId: string;
/** A seeded driver row with no `user_id` — a paper-only driver. */
let unlinkedDriverId: string;
let movementId: string;
let movementNumber: string;

async function userIdFor(email: string): Promise<string> {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY required");
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const user = data?.users.find((u) => u.email === email);
  if (!user) throw new Error(`seed user ${email} missing — run pnpm db:seed`);
  return user.id;
}

beforeAll(async () => {
  [driverUserId, dispatcherUserId] = await Promise.all([
    userIdFor("driver@pathfinder.demo"),
    userIdFor("dispatch@pathfinder.demo"),
  ]);

  const [linked] = await db
    .select({ id: drivers.id, orgId: drivers.organizationId })
    .from(drivers)
    .where(eq(drivers.userId, driverUserId))
    .limit(1);
  if (!linked) throw new Error("no seeded driver is linked to driver@pathfinder.demo");
  linkedDriverId = linked.id;
  orgId = linked.orgId;

  const others = await db
    .select({ id: drivers.id, userId: drivers.userId })
    .from(drivers)
    .where(eq(drivers.organizationId, orgId));
  const unlinked = others.find((d) => d.userId === null);
  if (!unlinked) throw new Error("expected a seeded driver with no linked user");
  unlinkedDriverId = unlinked.id;

  const [m] = await db
    .select({ id: movements.id, movementNumber: movements.movementNumber })
    .from(movements)
    .where(eq(movements.organizationId, orgId))
    .limit(1);
  movementId = m!.id;
  movementNumber = m!.movementNumber;
});

afterEach(async () => {
  await withServiceRole(db, async (tx) => {
    await tx
      .delete(notifications)
      .where(
        and(eq(notifications.userId, driverUserId), eq(notifications.type, "movement.assigned")),
      );
    await tx
      .delete(notifications)
      .where(
        and(eq(notifications.userId, dispatcherUserId), eq(notifications.type, "alert.critical")),
      );
    await tx
      .delete(notificationRules)
      .where(
        and(
          eq(notificationRules.userId, dispatcherUserId),
          eq(notificationRules.eventType, "alert.critical"),
        ),
      );
    await tx.delete(userDevices).where(eq(userDevices.userId, dispatcherUserId));
    await tx.delete(backgroundJobs).where(eq(backgroundJobs.jobType, "notification.push"));
    await tx
      .delete(notificationRules)
      .where(
        and(
          eq(notificationRules.userId, driverUserId),
          eq(notificationRules.eventType, "movement.assigned"),
        ),
      );
    await tx.delete(userDevices).where(eq(userDevices.userId, driverUserId));
  });
});

afterAll(async () => {
  await conn.sql.end();
});

/**
 * Run the two phases the way `movement.update` does: resolve inside the
 * dispatcher's RLS transaction, deliver only once it has committed — never a
 * service-role transaction nested inside an RLS one.
 */
async function assign(driverId: string, actorUserId: string | null = dispatcherUserId) {
  const pending = await withRls(
    db,
    { sub: dispatcherUserId, email: "dispatch@pathfinder.demo" },
    (tx) =>
      resolveDriverAssignment(tx, {
        orgId,
        driverId,
        movementId,
        movementNumber,
        actorUserId,
      }),
  );
  if (!pending) return { notified: 0, emailed: 0, pushed: 0 };
  return notifyUser(db, pending);
}

const inboxFor = (userId: string) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, "movement.assigned")));

describe("resolveDriverAssignment + notifyUser", () => {
  it("notifies the auth user behind the assigned driver", async () => {
    const result = await assign(linkedDriverId);
    expect(result.notified).toBe(1);

    const rows = await inboxFor(driverUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: orgId,
      type: "movement.assigned",
      title: `You are on ${movementNumber}`,
      linkPath: `/movements/${movementId}`,
      readAt: null,
    });
    // The driver app is the point of the event, so push is on out of the box.
    expect(rows[0]!.channel).toEqual(["in_app", "push"]);
  });

  it("says nothing for a driver with no linked auth user", async () => {
    expect(await assign(unlinkedDriverId)).toMatchObject({ notified: 0 });
    expect(await inboxFor(driverUserId)).toEqual([]);
  });

  it("does not notify the person who made the change", async () => {
    expect(await assign(linkedDriverId, driverUserId)).toMatchObject({ notified: 0 });
    expect(await inboxFor(driverUserId)).toEqual([]);
  });

  it("ignores a driver from another organization", async () => {
    const [foreign] = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.userId, driverUserId))
      .limit(1);
    // Same driver id, wrong org: the org filter must reject it.
    const pending = await withRls(
      db,
      { sub: dispatcherUserId, email: "dispatch@pathfinder.demo" },
      (tx) =>
        resolveDriverAssignment(tx, {
          orgId: "00000000-0000-4000-8000-000000000000",
          driverId: foreign!.id,
          movementId,
          movementNumber,
          actorUserId: dispatcherUserId,
        }),
    );
    expect(pending).toBeNull();
  });

  it("respects the recipient's opt-out", async () => {
    await withServiceRole(db, (tx) =>
      tx.insert(notificationRules).values({
        organizationId: orgId,
        userId: driverUserId,
        eventType: "movement.assigned",
        enabled: false,
        channel: ["in_app"],
      }),
    );
    expect(await assign(linkedDriverId)).toMatchObject({ notified: 0 });
    expect(await inboxFor(driverUserId)).toEqual([]);
  });

  it("honours a narrowed channel preference", async () => {
    await withServiceRole(db, (tx) =>
      tx.insert(notificationRules).values({
        organizationId: orgId,
        userId: driverUserId,
        eventType: "movement.assigned",
        enabled: true,
        channel: ["in_app"],
      }),
    );
    const result = await assign(linkedDriverId);
    expect(result).toMatchObject({ notified: 1, pushed: 0 });
    expect((await inboxFor(driverUserId))[0]!.channel).toEqual(["in_app"]);
  });
});

describe("notifyUser push delivery", () => {
  it("resolves the recipient's registered handsets through the service role", async () => {
    const token = `ExponentPushToken[assigned-${crypto.randomUUID()}]`;
    await withServiceRole(db, (tx) =>
      tx.insert(userDevices).values({
        userId: driverUserId,
        organizationId: orgId,
        expoPushToken: token,
        platform: "android",
      }),
    );
    // EXPO_PUSH_ENABLED is unset, so the send is mocked — what is under test is
    // that the tokens were reachable at all from inside notifyUser.
    const result = await notifyUser(db, {
      orgId,
      userId: driverUserId,
      eventType: "movement.assigned",
      title: `You are on ${movementNumber}`,
    });
    expect(result).toMatchObject({ notified: 1, pushed: 1 });
  });
});

describe("notifyOrganization push", () => {
  /**
   * The fan-out runs inside the caller's RLS transaction and must NOT open a
   * service-role one for the push — that would hold two pooled connections per
   * request. It enqueues a `notification.push` job instead, which the worker
   * (already service-role) delivers. This test walks both halves.
   */
  it("enqueues a push job inside the caller's transaction and lets the worker deliver it", async () => {
    await withServiceRole(db, async (tx) => {
      await tx.insert(notificationRules).values({
        organizationId: orgId,
        userId: dispatcherUserId,
        eventType: "alert.critical",
        enabled: true,
        channel: ["in_app", "push"],
      });
      await tx.insert(userDevices).values({
        userId: dispatcherUserId,
        organizationId: orgId,
        expoPushToken: `ExponentPushToken[fanout-${crypto.randomUUID()}]`,
        platform: "ios",
      });
    });

    const title = `Fan-out push ${crypto.randomUUID()}`;
    const result = await withRls(
      db,
      { sub: dispatcherUserId, email: "dispatch@pathfinder.demo" },
      (tx) =>
        notifyOrganization(tx, {
          orgId,
          eventType: "alert.critical",
          title,
          body: "body",
          linkPath: "/alerts",
        }),
    );

    expect(result.notified).toBeGreaterThan(0);
    expect(result.queuedPush).toBe(1);

    // The job is a real row, enqueued under the dispatcher's own RLS — proving
    // migration 0016's insert policy allows this producer.
    const jobs = await db
      .select()
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.organizationId, orgId),
          eq(backgroundJobs.jobType, "notification.push"),
        ),
      );
    expect(jobs).toHaveLength(1);

    // Now the worker half, on its own service-role transaction.
    const delivered = await withServiceRole(db, (tx) =>
      jobHandlers["notification.push"](tx, jobs[0]!),
    );
    expect(delivered).toMatchObject({ devices: 1 });
  });

  it("enqueues nothing when no recipient wants push", async () => {
    const result = await withRls(
      db,
      { sub: dispatcherUserId, email: "dispatch@pathfinder.demo" },
      (tx) =>
        notifyOrganization(tx, {
          orgId,
          eventType: "alert.critical",
          title: `No push ${crypto.randomUUID()}`,
        }),
    );
    expect(result.queuedPush).toBe(0);
    const jobs = await db
      .select()
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.organizationId, orgId),
          eq(backgroundJobs.jobType, "notification.push"),
        ),
      );
    expect(jobs).toEqual([]);
  });
});
