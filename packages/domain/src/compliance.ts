/**
 * Deterministic, explainable document-expiry rules (Phase 1).
 *
 * Pure functions — no I/O — so the same logic runs on registry save, in the
 * nightly scan, and (later) inside the risk-detection rules engine and the
 * mobile app's offline pre-flight checks.
 */
import type { AlertSeverity } from "./alert";

export type ExpiryEntityType = "driver" | "truck" | "trailer";

export interface ExpiryDocument {
  /** stable field identifier, e.g. "license_expiry" */
  field: string;
  /** human label, e.g. "Driver's license" */
  label: string;
  /** YYYY-MM-DD or null when not recorded */
  expiry: string | null;
  /** whether a missing date itself is a compliance gap (e.g. license) */
  requiredForCrossing: boolean;
}

export interface ExpiryFinding {
  field: string;
  label: string;
  dedupeKey: string;
  alertType: "document_expiry" | "missing_data";
  severity: AlertSeverity;
  title: string;
  description: string;
  dueAt: string | null;
  daysRemaining: number | null;
}

/** Thresholds (days before expiry) at which each severity starts. */
export const EXPIRY_THRESHOLDS = {
  warning: 60,
  critical: 14,
} as const;

/** Whole-day difference `to - from` for YYYY-MM-DD strings, timezone-agnostic. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Evaluate one entity's documents against `today`. Returns only actionable
 * findings; a document with >warning days left yields nothing.
 */
export function evaluateExpiries(
  entity: { type: ExpiryEntityType; id: string; displayName: string },
  docs: ExpiryDocument[],
  today: string = todayIso(),
): ExpiryFinding[] {
  const findings: ExpiryFinding[] = [];

  for (const d of docs) {
    const dedupeKey = `${entity.type}:${entity.id}:${d.field}`;

    if (!d.expiry) {
      if (d.requiredForCrossing) {
        findings.push({
          field: d.field,
          label: d.label,
          dedupeKey,
          alertType: "missing_data",
          severity: "warning",
          title: `${d.label} expiry not recorded — ${entity.displayName}`,
          description: `${d.label} for ${entity.displayName} has no expiry date on file. Customs will reject a manifest using an unverifiable document.`,
          dueAt: null,
          daysRemaining: null,
        });
      }
      continue;
    }

    const days = daysBetween(today, d.expiry);
    if (days > EXPIRY_THRESHOLDS.warning) continue;

    const severity: AlertSeverity = days <= EXPIRY_THRESHOLDS.critical ? "critical" : "warning";
    const state =
      days < 0
        ? `expired ${-days} day${days === -1 ? "" : "s"} ago`
        : days === 0
          ? "expires today"
          : `expires in ${days} day${days === 1 ? "" : "s"}`;

    findings.push({
      field: d.field,
      label: d.label,
      dedupeKey,
      alertType: "document_expiry",
      severity,
      title: `${d.label} ${state} — ${entity.displayName}`,
      description:
        days < 0
          ? `${d.label} for ${entity.displayName} expired on ${d.expiry}. Do not dispatch on a cross-border movement until renewed.`
          : `${d.label} for ${entity.displayName} expires on ${d.expiry}. Schedule renewal before the next crossing.`,
      dueAt: d.expiry,
      daysRemaining: days,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Document sets per entity type — single place the UI, API and scan agree on.
// ---------------------------------------------------------------------------

export function driverDocuments(d: {
  licenseExpiry: string | null;
  fastCardNumber?: string | null;
  fastCardExpiry: string | null;
  medicalCertExpiry: string | null;
}): ExpiryDocument[] {
  return [
    {
      field: "license_expiry",
      label: "Driver's license",
      expiry: d.licenseExpiry,
      requiredForCrossing: true,
    },
    // FAST card is optional; only track it if the driver has one.
    ...(d.fastCardNumber
      ? [
          {
            field: "fast_card_expiry",
            label: "FAST card",
            expiry: d.fastCardExpiry,
            requiredForCrossing: true,
          },
        ]
      : []),
    {
      field: "medical_cert_expiry",
      label: "Medical certificate",
      expiry: d.medicalCertExpiry,
      requiredForCrossing: false,
    },
  ];
}

export function truckDocuments(t: {
  registrationExpiry: string | null;
  insuranceExpiry: string | null;
  annualInspectionExpiry: string | null;
}): ExpiryDocument[] {
  return [
    {
      field: "registration_expiry",
      label: "Registration",
      expiry: t.registrationExpiry,
      requiredForCrossing: true,
    },
    {
      field: "insurance_expiry",
      label: "Insurance",
      expiry: t.insuranceExpiry,
      requiredForCrossing: true,
    },
    {
      field: "annual_inspection_expiry",
      label: "Annual inspection",
      expiry: t.annualInspectionExpiry,
      requiredForCrossing: false,
    },
  ];
}

export const trailerDocuments = truckDocuments;
