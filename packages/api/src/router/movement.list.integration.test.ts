/**
 * `movement.list`'s `readyToCross` SQL summary (Task 14), specifically the
 * review fix scoping the ACI branch's `pars_rns_events` check to PARS
 * shipments only. A non-PARS shipment never receives an RNS message (they're
 * matched by PARS/cargo-control number), so requiring one from every
 * attached shipment — PARS or not — would leave a real mixed movement stuck
 * at "pending" forever, even once the domain's own `crossingReadiness()`
 * (which already filters to `isPars` in `rnsReleaseCheck`, see
 * packages/domain/src/readiness.ts) would call it ready. The router's other
 * tests (`movement.test.ts`) run against a fake in-memory db and cannot
 * exercise the raw SQL subquery text this column is built from, so this
 * runs the real query against Postgres.
 *
 *   pnpm db:reset && pnpm db:seed && pnpm --filter @corridor/api test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "@corridor/auth";
import { createDb, eq, schema, withServiceRole } from "@corridor/db";
import type { Context } from "../context";
import { createCallerFactory } from "../trpc";
import { movementRouter } from "./movement";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

const conn = createDb(DB_URL, { max: 2 });
const db = conn.db;
const { organizations, movements, shipments, parsRnsEvents } = schema;

const createCaller = createCallerFactory(movementRouter);

const movementNumber = `ACI-RTC-${Date.now()}`;
let orgId: string;
let movementId: string;
let nonParsShipmentId: string;

beforeAll(async () => {
  // A fresh, disposable org — not a shared seed org — because this fixture
  // ends up leaving a `pars_rns_events` row behind (see afterAll) and that
  // should never bleed into a seeded org another test/spec counts rows in.
  const [org] = await db
    .insert(organizations)
    .values({ name: `RTC PARS scoping ${Date.now()}` })
    .returning({ id: organizations.id });
  orgId = org!.id;

  // `shipments_guard()` (0019/0022) only allows attaching a shipment while
  // the movement is editable, so the movement starts `draft`; it's walked
  // to `released` afterwards through the real state machine's path
  // (`movements_guard()` also enforces `movement_can_transition`).
  const [movement] = await db
    .insert(movements)
    .values({ organizationId: orgId, regime: "ACI", movementNumber, status: "draft" })
    .returning({ id: movements.id });
  movementId = movement!.id;

  // `control_reference` is constrained to `^[A-Z0-9]{4,20}$` — no hyphens.
  const ts = Date.now().toString();
  const [parsShipment, nonParsShipment] = await db
    .insert(shipments)
    .values([
      {
        organizationId: orgId,
        movementId,
        regime: "ACI",
        cargoType: "regular",
        carrierCode: "7ELU",
        controlReference: `PARS${ts}1`,
        isPars: true,
        status: "released",
      },
      {
        organizationId: orgId,
        movementId,
        regime: "ACI",
        cargoType: "regular",
        carrierCode: "7ELU",
        controlReference: `PARS${ts}2`,
        isPars: false,
        status: "released",
      },
    ])
    .returning({ id: shipments.id });
  nonParsShipmentId = nonParsShipment!.id;

  // Only the PARS shipment gets an RNS message — the non-PARS one never
  // will, in production or here.
  await db.insert(parsRnsEvents).values({
    organizationId: orgId,
    shipmentId: parsShipment!.id,
    parsNumber: `PARS-${ts}`,
    releaseCode: "0",
    releasedAt: new Date(),
  });

  for (const status of ["sent", "accepted", "released"] as const) {
    await db.update(movements).set({ status }).where(eq(movements.id, movementId));
  }
});

afterAll(async () => {
  // `pars_rns_events` is append-only (0027's `reject_modification` trigger
  // fires on DELETE too, and even on the UPDATE that an `on delete set null`
  // cascade would otherwise perform when the referencing shipment is
  // deleted) — same constraint `borderconnect.integration.test.ts`'s RNS
  // fixture hits. So, matching that precedent: the org (and everything under
  // it) is left behind rather than deleted — disposable local test data,
  // cleaned up wholesale by `pnpm db:reset`, not per-run.
  await conn.sql.end();
});

function callerFor(): ReturnType<typeof createCaller> {
  const session: Session = {
    user: { id: "00000000-0000-4000-8000-000000000000", email: null, displayName: null },
    memberships: [],
    activeOrganizationId: orgId,
    plan: "professional",
    permissions: new Set(["movement.read"]),
    accessToken: "test-access-token",
  };
  const ctx: Context = {
    session,
    supabase: {} as Context["supabase"],
    db: conn.db,
    headers: new Headers(),
    // Service-role, not `withRls`: this test's synthetic user was never
    // authenticated through Supabase, so it has no real membership/JWT for
    // RLS's `has_permission()` to check. Bypassing RLS here is safe — the
    // fixture already scopes every row to `orgId`, and this test's job is to
    // verify the `readyToCross` SQL column's own logic, not RLS itself
    // (which the cross-tenant integration tests own).
    rls: (fn) => withServiceRole(db, fn),
  };
  return createCaller(ctx);
}

describe("movement.list readyToCross — ACI PARS scoping (review fix)", () => {
  it("is ready when the only outstanding shipment is non-PARS", async () => {
    const caller = callerFor();
    const result = await caller.list({
      search: movementNumber,
      searchColumn: "movementNumber",
      limit: 200,
    });
    const row = result.rows.find((r) => r.id === movementId);
    expect(row).toBeDefined();
    expect(row?.readyToCross).toBe("ready");
  });

  it("the fixture's non-PARS shipment genuinely has no pars_rns_events row", async () => {
    // Sanity check on the fixture itself, so the "ready" result above is
    // known to come from the PARS filter and not from both shipments
    // happening to already have a release row.
    const rows = await db
      .select({ id: parsRnsEvents.id })
      .from(parsRnsEvents)
      .where(eq(parsRnsEvents.shipmentId, nonParsShipmentId));
    expect(rows).toHaveLength(0);
  });
});
