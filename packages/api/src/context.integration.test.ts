import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createDb, eq, schema } from "@corridor/db";
import { createContext } from "./context";
import { appRouter } from "./router/_app";

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const conn = createDb(DB_URL, { max: 2 });

afterAll(async () => {
  await conn.sql.end();
});

describe("createContext", () => {
  it("loads the signed-in user's membership when public is not exposed by PostgREST", async () => {
    if (!ANON_KEY) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY required");
    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await supabase.auth.signInWithPassword({
      email: "owner@northbound.demo",
      password: "corridor-demo",
    });
    if (error) throw error;

    const { error: publicSchemaError } = await supabase
      .from("organization_members")
      .select("organization_id")
      .limit(1);
    expect(publicSchemaError).toMatchObject({ code: "PGRST106" });

    const context = await createContext({ headers: new Headers(), supabase, db: conn.db });

    expect(context.session?.memberships).toEqual([
      expect.objectContaining({
        organizationName: "Northbound Freight Ltd",
        roleName: "Owner",
        status: "active",
      }),
    ]);
    expect(context.session?.activeOrganizationId).toBe(
      context.session?.memberships[0]?.organizationId,
    );
  });

  it("creates a tenant Owner and default carrier codes, then reuses that membership", async () => {
    if (!ANON_KEY) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY required");
    if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY required");
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const email = `context-onboarding-${crypto.randomUUID()}@corridor.test`;
    const password = "corridor-context-test";
    const { data: created, error: createUserError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: "Context Onboarding" },
    });
    if (createUserError) throw createUserError;

    let organizationId: string | undefined;
    try {
      const supabase = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      const initial = await createContext({ headers: new Headers(), supabase, db: conn.db });
      const caller = appRouter.createCaller(initial);

      ({ organizationId } = await caller.organization.create({
        name: "Context Onboarding Carrier",
        scacCode: "ctxt",
        canadianCarrierCode: "ctx1",
      }));
      await expect(
        caller.organization.create({ name: "Must Not Create A Duplicate" }),
      ).resolves.toEqual({ organizationId });

      const [membership] = await conn.db
        .select({
          organizationId: schema.organizationMembers.organizationId,
          roleName: schema.roles.name,
          roleOrganizationId: schema.roles.organizationId,
          isSystemRole: schema.roles.isSystem,
        })
        .from(schema.organizationMembers)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.organizationMembers.roleId))
        .where(eq(schema.organizationMembers.userId, created.user.id));
      expect(membership).toEqual({
        organizationId,
        roleName: "Owner",
        roleOrganizationId: organizationId,
        isSystemRole: false,
      });

      const codes = await conn.db
        .select({
          regime: schema.organizationCarrierCodes.regime,
          code: schema.organizationCarrierCodes.code,
          isDefault: schema.organizationCarrierCodes.isDefault,
        })
        .from(schema.organizationCarrierCodes)
        .where(eq(schema.organizationCarrierCodes.organizationId, organizationId))
        .orderBy(schema.organizationCarrierCodes.regime);
      expect(codes).toEqual([
        { regime: "ACE", code: "CTXT", isDefault: true },
        { regime: "ACI", code: "CTX1", isDefault: true },
      ]);

      const reloaded = await createContext({ headers: new Headers(), supabase, db: conn.db });
      expect(reloaded.session?.activeOrganizationId).toBe(organizationId);
      expect(reloaded.session?.permissions).toContain("organization.manage");
    } finally {
      if (organizationId) {
        await conn.db
          .delete(schema.organizations)
          .where(eq(schema.organizations.id, organizationId));
      }
      await admin.auth.admin.deleteUser(created.user.id);
    }
  });
});
