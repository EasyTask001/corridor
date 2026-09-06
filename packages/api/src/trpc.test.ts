import { describe, expect, it } from "vitest";
import type { Session } from "@corridor/auth";
import type { Context } from "./context";
import { createCallerFactory, enforcePermission, orgProcedure, router } from "./trpc";

const testRouter = router({
  transmit: orgProcedure
    .use(enforcePermission("movement.transmit_to_customs"))
    .mutation(() => "transmitted"),
  read: orgProcedure.use(enforcePermission("movement.read")).query(() => "ok"),
});
const createCaller = createCallerFactory(testRouter);

function ctx(session: Session | null): Context {
  return {
    session,
    supabase: {} as never,
    db: {} as never,
    rls: async () => {
      throw new Error("not used");
    },
  };
}

const base: Session = {
  user: { id: "u1", email: "u@x.test", displayName: null },
  memberships: [
    {
      organizationId: "o1",
      organizationName: "Org",
      roleId: "r",
      roleName: "Read-Only",
      status: "active",
    },
  ],
  activeOrganizationId: "o1",
  permissions: new Set(["movement.read"]),
  accessToken: "jwt",
};

describe("tRPC authorization middlewares", () => {
  it("rejects unauthenticated callers", async () => {
    await expect(createCaller(ctx(null)).read()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects callers with no active org", async () => {
    await expect(
      createCaller(ctx({ ...base, activeOrganizationId: null })).read(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("enforces permission keys", async () => {
    const caller = createCaller(ctx(base));
    await expect(caller.read()).resolves.toBe("ok");
    await expect(caller.transmit()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Missing permission: movement.transmit_to_customs",
    });
  });
});
