/**
 * Pre-transmit validation — deterministic, explainable, no I/O.
 * Used by `movement.validate` (UI checklist) and enforced by `movement.submit`.
 * Mirrors the data CBP ACE / CBSA ACI reject a manifest for when missing.
 */
import { daysBetween, todayIso } from "./compliance";
import type { CargoInput, Regime } from "./movement";

export type IssueSeverity = "blocking" | "warning";

export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  /** which wizard step fixes it */
  step: "trip" | "truck" | "crew" | "shipment" | "trailer" | "seals";
}

export interface MovementForValidation {
  regime: Regime;
  /** The port of entry / CBSA office, or null when not yet selected. */
  port: { code: string } | null;
  /** The carrier code this movement files under (migration 0018). */
  carrierCode: string | null;
  scheduledCrossingAt: string | null;
  driver: {
    licenseExpiry: string | null;
    fastCardNumber?: string | null;
    fastCardExpiry?: string | null;
    citizenship?: string | null;
    status: string;
  } | null;
  truck: {
    registrationExpiry: string | null;
    insuranceExpiry: string | null;
    plateNumber: string;
    status: string;
  } | null;
  trailer: {
    registrationExpiry: string | null;
    plateNumber: string;
    status: string;
  } | null;
  cargo: Array<
    Pick<
      CargoInput,
      | "commodityDescription"
      | "hsCode"
      | "weightKg"
      | "pieceCount"
      | "shipperId"
      | "consigneeId"
      | "valueAmount"
      | "valueCurrency"
      | "countryOfOrigin"
    >
  >;
  seals: Array<{ sealNumber: string }>;
}

function expired(iso: string | null | undefined, today: string): boolean {
  return !!iso && daysBetween(today, iso) < 0;
}

export function validateForTransmit(
  m: MovementForValidation,
  today: string = todayIso(),
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const block = (code: string, message: string, step: ValidationIssue["step"]) =>
    issues.push({ code, severity: "blocking", message, step });
  const warn = (code: string, message: string, step: ValidationIssue["step"]) =>
    issues.push({ code, severity: "warning", message, step });

  // --- trip ---
  if (!m.port)
    block("crossing_point_missing", "Select a port of entry / CBSA office.", "trip");
  if (!m.carrierCode)
    block(
      "carrier_code_missing",
      "No carrier code — add one on the organization settings page or select one for this trip.",
      "trip",
    );
  if (!m.scheduledCrossingAt)
    block("eta_missing", "Provide the estimated crossing date and time.", "trip");
  else if (daysBetween(today, m.scheduledCrossingAt.slice(0, 10)) < 0)
    warn("eta_past", "Scheduled crossing is in the past.", "trip");

  // --- truck ---
  if (!m.truck) block("truck_missing", "Assign a truck.", "truck");
  else {
    if (m.truck.status !== "active")
      block("truck_inactive", "Assigned truck is not active.", "truck");
    if (expired(m.truck.registrationExpiry, today))
      block("truck_registration_expired", "Truck registration has expired.", "truck");
    if (expired(m.truck.insuranceExpiry, today))
      block("truck_insurance_expired", "Truck insurance has expired.", "truck");
  }

  // --- crew ---
  if (!m.driver) block("driver_missing", "Assign a driver.", "crew");
  else {
    if (m.driver.status !== "active")
      block("driver_inactive", "Assigned driver is not active.", "crew");
    if (!m.driver.licenseExpiry)
      block("driver_license_unknown", "Driver's license expiry is not on file.", "crew");
    else if (expired(m.driver.licenseExpiry, today))
      block("driver_license_expired", "Driver's license has expired.", "crew");
    if (m.driver.fastCardNumber && expired(m.driver.fastCardExpiry, today))
      warn(
        "driver_fast_expired",
        "Driver's FAST card has expired — FAST lanes unavailable.",
        "crew",
      );
    if (!m.driver.citizenship)
      warn(
        "driver_citizenship_unknown",
        "Driver citizenship is not recorded (required on ACI/ACE crew data).",
        "crew",
      );
  }

  // --- shipment ---
  if (m.cargo.length === 0) block("cargo_missing", "Add at least one shipment line.", "shipment");
  m.cargo.forEach((c, i) => {
    const line = `Line ${i + 1}`;
    if (!c.shipperId) block(`cargo_${i}_shipper`, `${line}: shipper is required.`, "shipment");
    if (!c.consigneeId)
      block(`cargo_${i}_consignee`, `${line}: consignee is required.`, "shipment");
    if (!c.weightKg) block(`cargo_${i}_weight`, `${line}: weight is required.`, "shipment");
    if (!c.pieceCount) block(`cargo_${i}_pieces`, `${line}: piece count is required.`, "shipment");
    if (!c.hsCode)
      warn(`cargo_${i}_hs`, `${line}: no HS code — broker may need it for entry.`, "shipment");
    if (m.regime === "ACI" && !c.countryOfOrigin)
      warn(`cargo_${i}_origin`, `${line}: country of origin missing.`, "shipment");
    if (c.valueAmount != null && !c.valueCurrency)
      block(`cargo_${i}_currency`, `${line}: value has no currency.`, "shipment");
  });

  // --- trailer ---
  if (!m.trailer) warn("trailer_missing", "No trailer assigned (bobtail?).", "trailer");
  else {
    if (m.trailer.status !== "active")
      block("trailer_inactive", "Assigned trailer is not active.", "trailer");
    if (expired(m.trailer.registrationExpiry, today))
      block("trailer_registration_expired", "Trailer registration has expired.", "trailer");
  }

  // --- seals ---
  if (m.trailer && m.seals.length === 0)
    warn("seals_missing", "No seal recorded for the trailer.", "seals");

  return issues;
}

export function hasBlockingIssues(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "blocking");
}
