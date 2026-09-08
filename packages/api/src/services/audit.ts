import {
  schema,
  sql,
  withServiceRole,
  type DatabaseClient,
  type RlsTransaction,
} from "@corridor/db";

/** Write to the append-only audit log through its membership-checked DB function. */
export async function writeAudit(
  tx: RlsTransaction,
  organizationId: string,
  action: string,
  entityType: string,
  entityId: string,
  before?: unknown,
  after?: unknown,
) {
  const json = (value: unknown) =>
    value === null || value === undefined ? null : JSON.stringify(value);
  await tx.execute(sql`
    select public.log_audit(
      ${organizationId}::uuid, ${action}, ${entityType}, ${entityId},
      ${json(before)}::jsonb, ${json(after)}::jsonb
    )
  `);
}

/**
 * Audit an action taken by no user — a Stripe webhook, a cron worker. There is
 * no session to authorise `log_audit()` (it checks `is_org_member`), so this
 * inserts under the service role with a null `actor_id`.
 *
 * Only reachable from server-side code that already authenticated the caller
 * some other way (a verified webhook signature, the CRON_SECRET).
 */
export async function writeSystemAudit(
  db: DatabaseClient,
  organizationId: string,
  action: string,
  entityType: string,
  entityId: string,
  before?: unknown,
  after?: unknown,
) {
  await withServiceRole(db, (tx) =>
    tx.insert(schema.auditLog).values({
      organizationId,
      actorId: null,
      action,
      entityType,
      entityId,
      before: before ?? null,
      after: after ?? null,
    }),
  );
}

/**
 * Every tRPC **mutation** in `appRouter`, mapped to the audit action(s) it
 * writes. `audit-coverage.test.ts` walks `appRouter._def.procedures` and fails
 * the build when a mutation is missing here (or listed here but gone from the
 * router), so a new mutation cannot ship unaudited by accident.
 *
 * Adding a mutation is one line. If it genuinely should not be audited, put it
 * in `AUDIT_EXEMPT_MUTATIONS` below with the reason — never here.
 */
export const AUDITED_MUTATIONS: Record<string, string> = {
  // --- organization -------------------------------------------------------
  // written inside create_organization_with_owner() (migration 0001)
  "organization.create": "organization.create",
  "organization.update": "organization.update",
  "organization.roles.create": "role.create",
  "organization.roles.update": "role.update",
  "organization.roles.delete": "role.delete",
  "organization.members.invite": "member.invite",
  "organization.members.updateRole": "member.role_change",
  "organization.members.setStatus": "member.status_change",
  "organization.members.remove": "member.remove",
  // written inside accept_invitation() (migration 0001)
  "organization.members.acceptInvite": "member.accept_invite",
  "organization.sso.configure": "organization.sso_configure",
  "organization.sso.remove": "organization.sso_remove",
  "organization.carrierCodes.upsert":
    "organization.carrier_code_create / organization.carrier_code_update",
  "organization.carrierCodes.remove": "organization.carrier_code_remove",
  "organization.carrierCodes.setDefault": "organization.carrier_code_set_default",

  // --- registries ---------------------------------------------------------
  "party.drivers.create": "driver.create",
  "party.drivers.update": "driver.update",
  "party.drivers.archive": "driver.archive",
  "party.drivers.export": "driver.export",
  "party.drivers.documents.upsert": "driver.document_add / driver.document_update",
  "party.drivers.documents.remove": "driver.document_remove",
  "party.trucks.create": "truck.create",
  "party.trucks.update": "truck.update",
  "party.trucks.archive": "truck.archive",
  "party.trucks.export": "truck.export",
  "party.trailers.create": "trailer.create",
  "party.trailers.update": "trailer.update",
  "party.trailers.archive": "trailer.archive",
  "party.trailers.export": "trailer.export",
  "party.partners.create": "partner.create",
  "party.partners.update": "partner.update",
  "party.partners.archive": "partner.archive",
  "party.partners.export": "partner.export",

  // --- alerts -------------------------------------------------------------
  "alerts.setStatus": "alert.status_update",
  "alerts.rescan": "alert.rescan",

  // --- movements ----------------------------------------------------------
  "movement.create": "movement.create",
  "movement.update": "movement.update",
  "movement.crew.add": "movement.crew_add",
  "movement.crew.remove": "movement.crew_remove",
  "movement.crew.setRole": "movement.crew_set_role",
  "movement.trailers.add": "movement.trailer_add",
  "movement.trailers.remove": "movement.trailer_remove",
  "movement.trailers.reorder": "movement.trailer_reorder",
  "movement.seals.add": "movement.seal_add",
  "movement.seals.remove": "movement.seal_remove",
  "movement.addNote": "movement.note_add",
  "movement.submit": "movement.submit / movement.submit_failed",
  "movement.cancel": "movement.cancel",
  "movement.markArrived": "movement.mark_arrived",
  "movement.amend": "movement.amend",
  "movement.customsResponse": "movement.customs_response",
  "movement.suggestions.generate": "movement.suggestion_generate",
  "movement.suggestions.accept": "movement.suggestion_accept",
  "movement.suggestions.dismiss": "movement.suggestion_dismiss",

  // --- shipments ----------------------------------------------------------
  "shipment.create": "shipment.create",
  "shipment.update": "shipment.update",
  "shipment.remove": "shipment.remove",
  "shipment.commodities.upsert": "shipment.commodity_upsert",
  "shipment.commodities.remove": "shipment.commodity_remove",
  "shipment.assign": "shipment.assign",
  "shipment.unassign": "shipment.unassign",

  "organization.updateMe": "user.profile_update",

  // --- bulk import (0028) ---------------------------------------------------
  "imports.validate": "import.validate",
  "imports.commit": "import.commit",
  "imports.deleteBatch": "import.delete_batch",

  // --- in-bond (0026) -------------------------------------------------------
  "inbond.records.create": "inbond.record_create",
  "inbond.records.update": "inbond.record_update",
  "inbond.records.sendArrival": "inbond.send_arrival",
  "inbond.records.sendExport": "inbond.send_export",
  "inbond.records.cancel": "inbond.cancel",
  "inbond.records.requestStatus": "inbond.request_status",
  "inbond.records.addNote": "inbond.note_add",
  "inbond.external.create": "inbond.external_create",
  "inbond.external.update": "inbond.external_update",
  "inbond.external.close": "inbond.external_close",

  // --- integrations -------------------------------------------------------
  "integrations.configs.upsert": "integration.config_update",
  "integrations.configs.clearCredentials": "integration.credentials_cleared",
  "integrations.testCustoms": "integration.test_connection",
  "integrations.jobs.runNow": "job.run_now",

  // --- billing ------------------------------------------------------------
  "billing.checkout": "billing.session_opened",
  "billing.portal": "billing.session_opened",
  "billing.mockActivate": "billing.plan_change",

  // --- documents ----------------------------------------------------------
  "documents.getUploadUrl": "document.upload_reserved",
  "documents.finalizeUpload": "document.upload",
  "documents.retry": "document.retry",
  "documents.applyExtraction": "document.apply_extraction",
  "documents.remove": "document.remove",

  // --- notifications ------------------------------------------------------
  "notifications.rules.upsert": "notification.rule_update",
  "notifications.registerDevice": "notification.device_register",

  // --- reporting ----------------------------------------------------------
  "reporting.run": "report.run",
  "reporting.export": "report.export",

  // --- printable documents (0024) -----------------------------------------
  "pdf.generate": "pdf.generate",
  "pdf.blankDriverSheets": "pdf.blank_driver_sheets",
  "pdf.email": "pdf.email",
};

/**
 * Mutations that deliberately write no audit row, with the reason. Keep this
 * list short and justified — the audit log is the compliance record, and the
 * default for anything touching org data is to be in `AUDITED_MUTATIONS`.
 */
export const AUDIT_EXEMPT_MUTATIONS: Record<string, string> = {
  "notifications.markRead":
    "per-user UI state on the caller's own notification row; auditing it would " +
    "bury real org actions under one row per notification opened",
  "notifications.markAllRead": "same as notifications.markRead, in bulk",
};

/**
 * Actions written from outside the tRPC router, listed so the set is
 * discoverable in one place. Not covered by the coverage test (there is no
 * procedure to walk).
 */
export const NON_ROUTER_AUDIT_ACTIONS = {
  /** apps/web/src/app/api/webhooks/stripe/route.ts — actor_id null. */
  "billing.subscription_synced": "Stripe webhook mirrored a subscription change",
} as const;
