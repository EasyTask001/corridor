import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { PermissionKey } from "@corridor/domain";
import type { Session } from "@corridor/auth";
import type { Context } from "./context";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createCallerFactory = t.createCallerFactory;
export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

/** Requires an authenticated user (any org state — used for onboarding). */
export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, session: ctx.session } });
});

export type AuthedContext = Context & { session: Session };
export type OrgContext = AuthedContext & { orgId: string };

/** Requires an active org membership. */
export const orgProcedure = authedProcedure.use(({ ctx, next }) => {
  const orgId = ctx.session.activeOrganizationId;
  if (!orgId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "No active organization" });
  }
  return next({ ctx: { ...ctx, orgId } });
});

/**
 * Feature/action boundary on top of RLS. Usage:
 *   orgProcedure.use(enforcePermission("movement.transmit_to_customs"))
 */
export function enforcePermission(...required: PermissionKey[]) {
  return middleware(({ ctx, next }) => {
    const session = ctx.session;
    if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
    const missing = required.filter((p) => !session.permissions.has(p));
    if (missing.length > 0) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Missing permission: ${missing.join(", ")}`,
      });
    }
    return next();
  });
}

/** Requires at least one permission from a list (for full vs assigned-only reads). */
export function enforceAnyPermission(...allowed: PermissionKey[]) {
  return middleware(({ ctx, next }) => {
    const session = ctx.session;
    if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
    if (!allowed.some((permission) => session.permissions.has(permission))) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Missing one of: ${allowed.join(", ")}`,
      });
    }
    return next();
  });
}

export const permissionProcedure = (...required: PermissionKey[]) =>
  orgProcedure.use(enforcePermission(...required));

export const anyPermissionProcedure = (...allowed: PermissionKey[]) =>
  orgProcedure.use(enforceAnyPermission(...allowed));
