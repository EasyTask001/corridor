import { publicProcedure, router } from "../trpc";
import { alertsRouter } from "./alerts";
import { billingRouter } from "./billing";
import { documentsRouter } from "./documents";
import { integrationsRouter } from "./integrations";
import { movementRouter } from "./movement";
import { notificationsRouter } from "./notifications";
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
  documents: documentsRouter,
  notifications: notificationsRouter,
});

export type AppRouter = typeof appRouter;
