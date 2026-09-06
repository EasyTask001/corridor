import { publicProcedure, router } from "../trpc";
import { alertsRouter } from "./alerts";
import { organizationRouter } from "./organization";
import { partyRouter } from "./party";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, at: new Date().toISOString() })),
  organization: organizationRouter,
  party: partyRouter,
  alerts: alertsRouter,
});

export type AppRouter = typeof appRouter;
