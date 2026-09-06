import { publicProcedure, router } from "../trpc";
import { organizationRouter } from "./organization";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, at: new Date().toISOString() })),
  organization: organizationRouter,
});

export type AppRouter = typeof appRouter;
