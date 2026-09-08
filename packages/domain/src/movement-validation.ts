/**
 * Pre-transmit validation — deterministic, explainable, no I/O.
 * Used by `movement.validate` (UI checklist) and enforced by `movement.submit`.
 * Mirrors the data CBP ACE / CBSA ACI reject a manifest for when missing.
 */
import { daysBetween, todayIso } from "./compliance";
import type { Regime } from "./movement";
import type { CrewRole } from "./movement-inputs";
import type { Address, DriverDocumentType, PersonType } from "./registry";
import type { AceShipmentType, AciCargoType, InBondEntryType } from "./shipment";

export type IssueSeverity = "blocking" | "warning";

export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  /** which wizard step fixes it */
  step: "trip" | "truck" | "crew" | "shipment" | "commodity" | "trailer" | "seals";
}

/** A party as the manifest needs it: a name to print and a country to sanity-check. */
export interface PartyForValidation {
  name: string;
  country: string | null;
}

/** The commodity fields a manifest is rejected for, as stored (not as typed). */
export interface CommodityForValidation {
  commodityDescription: string;
  hsCode?: string | null;
  weightKg?: number | null;
  quantity?: number | null;
  quantityUnit?: string | null;
  valueAmount?: number | null;
  valueCurrency?: string | null;
  countryOfOrigin?: string | null;
}

export interface ShipmentForValidation {
  controlNumber: string;
  /** ACE files a shipment type, ACI a cargo type — exactly one is set. */
  shipmentType: AceShipmentType | null;
  cargoType: AciCargoType | null;
  shipper: PartyForValidation | null;
  consignee: PartyForValidation | null;
  entryNumber: string | null;
  inBondEntryType: InBondEntryType | null;
  inBondDestinationPortId: string | null;
  /** ACI destination office; every shipment on an in-transit trip needs one. */
  destinationPortId: string | null;
  commodities: CommodityForValidation[];
}

/** One person on the crossing, as `movement_crew` joined to `drivers` stores it. */
export interface CrewForValidation {
  role: CrewRole;
  personType: PersonType;
  displayName: string;
  licenseExpiry: string | null;
  status: string;
  citizenship: string | null;
  /** Empty `{}` when no US address is on file (the column default). */
  usAddress: Address;
  documents: Array<{ documentType: DriverDocumentType; expiresOn: string | null }>;
}

export interface MovementForValidation {
  regime: Regime;
  /** The port of entry / CBSA office, or null when not yet selected. */
  port: { code: string } | null;
  /** The carrier code this movement files under (migration 0018). */
  carrierCode: string | null;
  scheduledCrossingAt: string | null;
  crew: CrewForValidation[];
  truck: {
    registrationExpiry: string | null;
    insuranceExpiry: string | null;
    plateNumber: string;
    status: string;
  } | null;
  /** "Empty Trailer" (ACE) / "Empty Trip" (ACI): the crossing carries no goods. */
  isEmpty: boolean;
  /** ACI "in transit" flag (0022): goods cross Canada without entering it. */
  aciInTransit: boolean;
  /** In tow order, each with the seals recorded on it. */
  trailers: TrailerForValidation[];
  shipments: ShipmentForValidation[];
  /** Every seal on the movement, trailer-mounted or on the truck. */
  seals: Array<{ sealNumber: string }>;
}

export interface TrailerForValidation {
  unitNumber: string;
  registrationExpiry: string | null;
  plateNumber: string;
  status: string;
  sealCount: number;
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
  if (!m.port) block("crossing_point_missing", "Select a port of entry / CBSA office.", "trip");
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
  const pic = m.crew.find((c) => c.role === "person_in_charge");
  if (!pic) block("crew_pic_missing", "Assign a person in charge (the driver).", "crew");
  else if (pic.personType !== "driver")
    block(
      "crew_pic_not_driver",
      `${pic.displayName} is recorded as a passenger and cannot be the person in charge.`,
      "crew",
    );

  m.crew.forEach((c, i) => {
    const at = (suffix: string) => `crew_${i}_${suffix}`;
    if (c.status !== "active")
      block(at("inactive"), `${c.displayName} is not an active crew record.`, "crew");

    if (c.personType === "driver") {
      if (!c.licenseExpiry)
        block(at("license_unknown"), `${c.displayName}: license expiry is not on file.`, "crew");
      else if (expired(c.licenseExpiry, today))
        block(at("license_expired"), `${c.displayName}: license has expired.`, "crew");
    } else if (c.documents.length === 0) {
      block(
        at("passenger_document_missing"),
        `${c.displayName}: a passenger needs at least one travel document.`,
        "crew",
      );
    }

    for (const d of c.documents) {
      if ((d.documentType === "fast" || d.documentType === "nexus") && expired(d.expiresOn, today))
        warn(
          at(`${d.documentType}_expired`),
          `${c.displayName}: ${d.documentType === "fast" ? "FAST" : "NEXUS"} card has expired — trusted-traveller lanes unavailable.`,
          "crew",
        );
    }

    if (!c.citizenship)
      warn(
        at("citizenship_unknown"),
        `${c.displayName}: citizenship is not recorded (required on ACE/ACI crew data).`,
        "crew",
      );
  });

  // --- shipments ---
  // ACE moves goods into the US, so the shipper is normally Canadian and the
  // consignee American; ACI is the mirror image. A cross-border pair that does
  // not follow that shape is legal but nearly always a data-entry slip.
  const expectedShipperCountry = m.regime === "ACE" ? "CA" : "US";
  const expectedConsigneeCountry = m.regime === "ACE" ? "US" : "CA";

  if (m.isEmpty && m.shipments.length > 0)
    block(
      "empty_with_shipments",
      "The trip is marked empty but carries shipments — clear the flag or unassign them.",
      "shipment",
    );
  else if (m.shipments.length === 0 && !m.isEmpty) {
    // An empty crossing is legal and filed as such; anything else needs a
    // shipment, and a bobtail with nothing to declare needs the empty flag.
    if (m.trailers.length === 0)
      block(
        "empty_or_missing",
        "Add a trailer and a shipment, or mark the trip empty.",
        "shipment",
      );
    else block("shipments_missing", "Add or assign at least one shipment.", "shipment");
  }

  m.shipments.forEach((s, i) => {
    const label = s.controlNumber || `Shipment ${i + 1}`;
    const at = (suffix: string) => `shipment_${i}_${suffix}`;

    if (!s.shipper) block(at("shipper"), `${label}: shipper is required.`, "shipment");
    else if (s.shipper.country && s.shipper.country !== expectedShipperCountry)
      warn(
        at("shipper_country"),
        `${label}: shipper is in ${s.shipper.country}, not ${expectedShipperCountry} as ${m.regime} usually expects.`,
        "shipment",
      );

    if (!s.consignee) block(at("consignee"), `${label}: consignee is required.`, "shipment");
    else if (s.consignee.country && s.consignee.country !== expectedConsigneeCountry)
      warn(
        at("consignee_country"),
        `${label}: consignee is in ${s.consignee.country}, not ${expectedConsigneeCountry} as ${m.regime} usually expects.`,
        "shipment",
      );

    if (s.shipmentType === "in_bond" && (!s.inBondEntryType || !s.inBondDestinationPortId))
      block(
        at("in_bond"),
        `${label}: an in-bond shipment needs an entry type (IT/TE/IE) and a destination port.`,
        "shipment",
      );

    if (m.regime === "ACI" && m.aciInTransit && !s.destinationPortId)
      block(
        at("in_transit_destination"),
        `${label}: an in-transit trip needs a destination office on every shipment.`,
        "shipment",
      );

    if (s.cargoType === "consolidated" && s.commodities.length < 2)
      block(
        at("consolidated"),
        `${label}: a consolidated cargo type needs at least two commodity lines.`,
        "shipment",
      );

    if (s.commodities.length === 0)
      block(at("commodities"), `${label}: add at least one commodity line.`, "commodity");

    s.commodities.forEach((c, j) => {
      const line = `${label} line ${j + 1}`;
      const code = (suffix: string) => `shipment_${i}_commodity_${j}_${suffix}`;
      if (!c.weightKg) block(code("weight"), `${line}: weight is required.`, "commodity");
      if (!c.quantity) block(code("quantity"), `${line}: quantity is required.`, "commodity");
      if (!c.quantityUnit)
        block(code("quantity_unit"), `${line}: quantity unit is required.`, "commodity");
      if (c.valueAmount != null && !c.valueCurrency)
        block(code("currency"), `${line}: value has no currency.`, "commodity");
      if (!c.hsCode)
        warn(code("hs"), `${line}: no HS code — broker may need it for entry.`, "commodity");
      if (m.regime === "ACI" && !c.countryOfOrigin)
        warn(code("origin"), `${line}: country of origin missing.`, "commodity");
    });
  });

  // --- crew x shipments ---
  // CBP wants a US destination address for a passenger riding along on an ACE
  // crossing whose goods are not consigned to a US party.
  if (
    m.regime === "ACE" &&
    m.shipments.some((s) => s.consignee?.country && s.consignee.country !== "US")
  ) {
    m.crew.forEach((c, i) => {
      if (c.personType === "passenger" && Object.keys(c.usAddress).length === 0)
        warn(
          `crew_${i}_us_address_missing`,
          `${c.displayName}: ACE needs a US address for a passenger when the consignee is not US.`,
          "crew",
        );
    });
  }

  // --- trailers ---
  if (m.trailers.length === 0) warn("trailer_missing", "No trailer assigned (bobtail?).", "trailer");
  m.trailers.forEach((t, i) => {
    const at = (suffix: string) => `trailer_${i}_${suffix}`;
    if (t.status !== "active")
      block(at("inactive"), `Trailer ${t.unitNumber} is not active.`, "trailer");
    if (expired(t.registrationExpiry, today))
      block(at("registration_expired"), `Trailer ${t.unitNumber}: registration has expired.`, "trailer");
    // --- seals ---
    if (t.sealCount === 0)
      warn(at("seals_missing"), `No seal recorded for trailer ${t.unitNumber}.`, "seals");
  });

  return issues;
}

export function hasBlockingIssues(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "blocking");
}
