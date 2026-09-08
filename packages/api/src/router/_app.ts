import { publicProcedure, router } from "../trpc";
import { alertsRouter } from "./alerts";
import { auditRouter } from "./audit";
import { billingRouter } from "./billing";
import { copilotRouter } from "./copilot";
import { documentsRouter } from "./documents";
import { integrationsRouter } from "./integrations";
import { movementRouter } from "./movement";
import { notificationsRouter } from "./notifications";
import { organizationRouter } from "./organization";
import { partyRouter } from "./party";
import { pdfRouter } from "./pdf";
import { referenceRouter } from "./reference";
import { reportingRouter } from "./reporting";
import { shipmentRouter } from "./shipment";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, at: new Date().toISOString() })),
  organization: organizationRouter,
  party: partyRouter,
  alerts: alertsRouter,
  audit: auditRouter,
  movement: movementRouter,
  shipment: shipmentRouter,
  integrations: integrationsRouter,
  billing: billingRouter,
  copilot: copilotRouter,
  documents: documentsRouter,
  notifications: notificationsRouter,
  reporting: reportingRouter,
  reference: referenceRouter,
  pdf: pdfRouter,
});

export type AppRouter = typeof appRouter;
