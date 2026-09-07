import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { PermissionKey } from "@corridor/domain";
import type { Session } from "@corridor/auth";
import type { Context } from "./context";
import { RateLimitExceededError, rateLimitFor, type RateLimitTier } from "./infra/ratelimit";

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

/**
 * Sliding-window rate limit for the caller's plan. Counted per user within the
 * org for `standard` and per org for `ai` (see `rateLimitKey`) — never by IP,
 * so a tenant cannot be throttled by another tenant behind the same NAT.
 */
export function rateLimited(tier: RateLimitTier) {
  return middleware(async ({ ctx, next }) => {
    const session = ctx.session;
    if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
    const result = await rateLimitFor(tier, session.plan).check({
      orgId: session.activeOrganizationId,
      userId: session.user.id,
    });
    if (!result.success) {
      const cause = new RateLimitExceededError(
        tier,
        session.plan,
        result.limit,
        result.retryAfterSeconds,
      );
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: cause.message, cause });
    }
    return next();
  });
}

/**
 * Requires an authenticated user (any org state — used for onboarding).
 * Carries the `standard` rate-limit tier, which `orgProcedure` inherits.
 */
export const authedProcedure = t.procedure
  .use(({ ctx, next }) => {
    if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
    return next({ ctx: { ...ctx, session: ctx.session } });
  })
  .use(rateLimited("standard"));

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

/**
 * For procedures that spend model tokens (extraction, suggestions, reporting,
 * copilot). Permission is checked first so a forbidden call does not eat the
 * caller's much smaller `ai` budget.
 */
export const aiProcedure = (...required: PermissionKey[]) =>
  orgProcedure.use(enforcePermission(...required)).use(rateLimited("ai"));
