/** Public PAPS/PARS status lookup (0027): gated, rate-limited, minimal. */
import { TRPCError } from "@trpc/server";
import { trackingLookupInput } from "@corridor/domain";
import { publicProcedure, router } from "../trpc";
import { lookupShipmentStatus, trackingKeyFor, trackingRateLimit } from "../services/tracking";

export const trackingRouter = router({
  lookup: publicProcedure.input(trackingLookupInput).query(async ({ ctx, input }) => {
    const key = trackingKeyFor(ctx.headers);
    const limit = await trackingRateLimit(key);
    if (!limit.success) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Too many lookups. Try again in ${limit.retryAfterSeconds}s.`,
      });
    }
    return lookupShipmentStatus(ctx.db, input);
  }),
});
