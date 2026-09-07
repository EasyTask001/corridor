import { publicProcedure, router } from "../trpc";
import { alertsRouter } from "./alerts";
import { billingRouter } from "./billing";
import { integrationsRouter } from "./integrations";
import { movementRouter } from "./movement";
import { organizationRouter } from "./organization";
import { partyRouter } from "./party";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, at: new Date().toISOString() })),
  organization: organizationRouter,
  party: partyRouter,
  alerts: alertsRouter,
  movement: movementRouter,
  integrations: integrationsRouter,
  billing: billingRouter,
});

export type AppRouter = typeof appRouter;
