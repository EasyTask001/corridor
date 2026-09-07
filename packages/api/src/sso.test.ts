/**
 * The Enterprise gate on `organization.sso.*`.
 *
 * The plan check is a middleware, so it runs before any resolver touches the
 * database — which is what lets these tests use a context whose `rls` throws.
 * A call that gets past the gate fails with that marker instead of FORBIDDEN.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@corridor/auth";
import type { SubscriptionPlan } from "@corridor/domain";
import { organizationRouter } from "./router/organization";
import { createCallerFactory } from "./trpc";
import type { Context } from "./context";

const PAST_THE_GATE = "reached the resolver";

function caller(plan: SubscriptionPlan, permissions: string[] = ["organization.manage"]) {
  const session: Session = {
    user: { id: "u1", email: "owner@acme.test", displayName: null },
    memberships: [
      {
        organizationId: "o1",
        organizationName: "Acme",
        roleId: "r1",
        roleName: "Owner",
        status: "active",
      },
    ],
    activeOrganizationId: "o1",
    plan,
    permissions: new Set(permissions) as Session["permissions"],
    accessToken: "jwt",
  };
  const ctx: Context = {
    session,
    supabase: {} as never,
    db: {} as never,
    rls: async () => {
      throw new Error(PAST_THE_GATE);
    },
  };
  return createCallerFactory(organizationRouter)(ctx);
}

describe("organization.sso enterprise gate", () => {
  for (const plan of ["trial", "starter", "professional"] as const) {
    it(`refuses a ${plan} tenant`, async () => {
      await expect(caller(plan).sso.get()).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "SSO requires the Enterprise plan",
      });
      await expect(
        caller(plan).sso.configure({
          metadataUrl: "https://idp.acme.test/metadata",
          domains: ["acme.test"],
          enforced: false,
        }),
      ).rejects.toMatchObject({ message: "SSO requires the Enterprise plan" });
      await expect(caller(plan).sso.remove()).rejects.toMatchObject({
        message: "SSO requires the Enterprise plan",
      });
    });
  }

  it("lets an enterprise tenant through to the resolver", async () => {
    await expect(caller("enterprise").sso.get()).rejects.toThrow(PAST_THE_GATE);
  });

  it("still requires organization.manage on the Enterprise plan", async () => {
    await expect(caller("enterprise", ["organization.read"]).sso.get()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Missing permission: organization.manage",
    });
  });
});
