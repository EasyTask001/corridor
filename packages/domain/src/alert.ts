import { z } from "zod";
import { isoDate, isoDateTime, uuid } from "./common";

export const alertType = z.enum([
  "document_expiry",
  "hold_prediction",
  "risk_flag",
  "missing_data",
  "hs_code_mismatch",
]);
export type AlertType = z.infer<typeof alertType>;

export const alertSeverity = z.enum(["info", "warning", "critical"]);
export type AlertSeverity = z.infer<typeof alertSeverity>;

export const alertStatus = z.enum(["open", "acknowledged", "resolved", "dismissed"]);
export type AlertStatus = z.infer<typeof alertStatus>;

export const alertSource = z.enum(["rules", "ai", "user"]);
export type AlertSource = z.infer<typeof alertSource>;

export const complianceAlertSchema = z.object({
  id: uuid,
  organizationId: uuid,
  movementId: uuid.nullable(),
  driverId: uuid.nullable(),
  truckId: uuid.nullable(),
  trailerId: uuid.nullable(),
  alertType,
  severity: alertSeverity,
  title: z.string(),
  description: z.string().nullable(),
  status: alertStatus,
  dedupeKey: z.string().nullable(),
  source: alertSource,
  dueAt: isoDate.nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type ComplianceAlert = z.infer<typeof complianceAlertSchema>;

export const alertListInput = z.object({
  status: z.array(alertStatus).default(["open", "acknowledged"]),
  severity: z.array(alertSeverity).optional(),
  alertType: z.array(alertType).optional(),
  entity: z
    .object({
      driverId: uuid.optional(),
      truckId: uuid.optional(),
      trailerId: uuid.optional(),
      movementId: uuid.optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type AlertListInput = z.infer<typeof alertListInput>;

/** Status transitions a user may apply. Resolution of rule alerts also happens automatically when the underlying document is renewed. */
export const ALERT_TRANSITIONS: Record<AlertStatus, readonly AlertStatus[]> = {
  open: ["acknowledged", "resolved", "dismissed"],
  acknowledged: ["resolved", "dismissed", "open"],
  resolved: ["open"],
  dismissed: ["open"],
};

export function canTransitionAlert(from: AlertStatus, to: AlertStatus): boolean {
  return ALERT_TRANSITIONS[from].includes(to);
}
