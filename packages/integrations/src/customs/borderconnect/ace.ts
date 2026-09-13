/**
 * `ManifestPayload` → BorderConnect `ACE_TRIP` (the US CBP eManifest JSON
 * message). Field-by-field rules are from the ACE JSON reference manual — see
 * the task-5 plan for the exact citations. `validateForBorderConnect` runs
 * first and throws one 422 naming every problem; everything past that point
 * assumes the manifest is BorderConnect-shaped and never 422s again.
 *
 * `buildParty`/`buildAddress`/`buildLicensePlates`/`buildTravelDocument`/
 * `buildDriver` are exported for `aci.ts` to reuse — the ACI shipper/
 * consignee/driver shapes are documented as identical to ACE's.
 */
import type { ManifestParty, ManifestPayload, ManifestPlate } from "../types";
import { CustomsTransportError } from "../types";
import { bcDateTime, tripNumberFor, type OutboundOptions } from "./format";
import {
  ACE_SHIPMENT_TYPE_MAP,
  findAcePackagingUnit,
  mapDriverDocumentType,
  mappedDriverDocuments,
  mapTrailerType,
} from "./code-lists";
import { loadedOnWireField } from "./loaded-on";
import { validateForBorderConnect } from "./validate";

const FAST_CARD_NUMBER = /^4270[0-9]{8}0[12]$/;

/** Builds the `{addressLine, city, postalCode, stateProvince, country}` shape
 * from a structured postal address (a party's, or a shipment's bare `delivery`). */
export function buildAddress(postal: ManifestParty["postal"]): Record<string, unknown> {
  return {
    addressLine: [postal?.line1, postal?.line2].filter((p): p is string => !!p).join(" "),
    city: postal?.city ?? null,
    postalCode: postal?.postalCode ?? null,
    stateProvince: postal?.region ?? null,
    country: postal?.country ?? null,
  };
}

export function buildParty(party: ManifestParty | null): Record<string, unknown> {
  return { name: party?.name ?? null, address: buildAddress(party?.postal ?? null) };
}

export function buildLicensePlates(
  primary: { plate: string; plateJurisdiction: string },
  extra: ManifestPlate[],
): Array<Record<string, unknown>> {
  return [
    { number: primary.plate, stateProvince: primary.plateJurisdiction },
    ...extra.map((p) => ({ number: p.plate, stateProvince: p.jurisdiction })),
  ].slice(0, 2);
}

export function buildTravelDocument(
  d: ManifestPayload["crew"][number]["documents"][number],
): Record<string, unknown> | undefined {
  const type = mapDriverDocumentType(d.type);
  if (!type) return undefined;
  return {
    type,
    number: d.number,
    ...(d.issuingCountry ? { country: d.issuingCountry } : {}),
    ...(d.issuingState ? { stateProvince: d.issuingState } : {}),
  };
}

function travelDocuments(
  documents: ManifestPayload["crew"][number]["documents"],
): Array<Record<string, unknown>> {
  // `mappedDriverDocuments` is the same filter `validate.ts` counts against,
  // so "the validator said this person has a document" and "the wire carries
  // one" can never disagree.
  return mappedDriverDocuments(documents)
    .map(buildTravelDocument)
    .filter((d): d is Record<string, unknown> => d !== undefined);
}

export function buildDriver(c: ManifestPayload["crew"][number]): Record<string, unknown> {
  const fastDoc = c.documents.find((d) => d.type === "fast" && FAST_CARD_NUMBER.test(d.number));
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    ...(c.gender === "M" || c.gender === "F" ? { gender: c.gender } : {}),
    dateOfBirth: c.dateOfBirth,
    citizenshipCountry: c.citizenship,
    ...(fastDoc ? { fastCardNumber: fastDoc.number } : {}),
    travelDocuments: travelDocuments(c.documents),
  };
}

/** ACE-only: passengers are validated (`validate.ts`) to have gender/dateOfBirth/citizenship/documents. */
function buildPassenger(c: ManifestPayload["crew"][number]): Record<string, unknown> {
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    gender: c.gender,
    dateOfBirth: c.dateOfBirth,
    citizenshipCountry: c.citizenship,
    travelDocuments: travelDocuments(c.documents),
  };
}

/**
 * `instrumentsOfInternationalTrafficBond` is a top-level `ACE_TRIP` field
 * (one per trip), computed once from `m.trip.iitIndicator` — matching that
 * field already being trip-scoped in `ManifestPayload`, not one per
 * shipment. Never attach this to a nested `ACE_SHIPMENT`.
 */
function iitBondField(
  indicator: ManifestPayload["trip"]["iitIndicator"],
): { type: "CARRIER" | "IMPORTER" } | undefined {
  if (indicator === "iit_carrier_bond") return { type: "CARRIER" };
  if (indicator === "iit_importer_bond") return { type: "IMPORTER" };
  return undefined;
}

function buildAceCommodity(
  c: ManifestPayload["shipments"][number]["commodities"][number],
  loadedOn: { type: "TRUCK" | "TRAILER"; number: string } | undefined,
): Record<string, unknown> {
  return {
    description: c.description,
    quantity: c.quantity,
    packagingUnit: findAcePackagingUnit(c.packagingType ?? ""),
    weight: c.weightKg,
    weightUnit: "KG",
    ...(c.marksAndNumbers ? { marksAndNumbers: [c.marksAndNumbers] } : {}),
    ...(c.hsCode ? { harmonizedCode: c.hsCode.replace(/\D/g, "") } : {}),
    ...(c.value?.currency === "USD" ? { value: String(c.value.amount) } : {}),
    ...(c.countryOfOrigin ? { countryOfOrigin: c.countryOfOrigin } : {}),
    // ACE puts loadedOn on the commodity (1.0.7 §1.15.1.16.1.13), not the
    // shipment — every commodity on this shipment gets the same placement.
    ...(loadedOn ? { loadedOn } : {}),
  };
}

function buildAceShipment(
  s: ManifestPayload["shipments"][number],
  companyKey: string,
): Record<string, unknown> {
  const loadedOn = loadedOnWireField(s);
  return {
    data: "ACE_SHIPMENT",
    companyKey,
    shipmentControlNumber: s.controlNumber,
    type: s.shipmentType ? ACE_SHIPMENT_TYPE_MAP[s.shipmentType] : undefined,
    provinceOfLoading: s.loading.province,
    shipper: buildParty(s.shipper),
    consignee: buildParty(s.consignee),
    commodities: s.commodities.map((c) => buildAceCommodity(c, loadedOn)),
  };
}

/**
 * Builds an `ACE_TRIP` send-request body. Throws a 422 `CustomsTransportError`
 * naming every unmet BorderConnect requirement at once (see `validate.ts`).
 */
export function toAceTrip(m: ManifestPayload, o: OutboundOptions): Record<string, unknown> {
  const problems = validateForBorderConnect(m);
  if (problems.length > 0) {
    throw new CustomsTransportError(
      `BorderConnect: manifest is missing ${problems.length} required field(s): ${problems.join("; ")}`,
      422,
      false,
    );
  }

  const tripNumber = o.tripNumberOverride ?? tripNumberFor(m);
  const passengers = m.crew.filter((c) => c.role === "passenger").map(buildPassenger);
  const bond = iitBondField(m.trip.iitIndicator);

  return {
    data: "ACE_TRIP",
    sendId: o.sendId,
    companyKey: o.companyKey,
    operation: o.operation,
    autoSend: o.autoSend,
    tripNumber,
    estimatedArrivalDateTime: bcDateTime(m.trip.estimatedArrival, m.carrier.timezone),
    usPortOfArrival: m.trip.portOfEntry.padStart(4, "0"),
    ...(bond ? { instrumentsOfInternationalTrafficBond: bond } : {}),
    truck: {
      number: m.conveyance.unitNumber,
      type: m.conveyance.truckType,
      vinNumber: m.conveyance.vin,
      licensePlates: buildLicensePlates(
        { plate: m.conveyance.plate, plateJurisdiction: m.conveyance.plateJurisdiction },
        m.conveyance.plates,
      ),
      sealNumbers: m.conveyance.seals,
      ...(m.conveyance.dotNumber ? { dotNumber: m.conveyance.dotNumber } : {}),
    },
    trailers: m.equipment.map((t) => ({
      number: t.unitNumber,
      type: mapTrailerType(t.type),
      licensePlates: buildLicensePlates(
        { plate: t.plate, plateJurisdiction: t.plateJurisdiction },
        t.plates,
      ),
      sealNumbers: t.seals,
    })),
    drivers: m.crew
      .filter((c) => c.role === "person_in_charge" || c.role === "crew_member")
      .map(buildDriver),
    ...(passengers.length > 0 ? { passengers } : {}),
    shipments: m.shipments.map((s) => buildAceShipment(s, o.companyKey)),
  };
}

export type { OutboundOptions };
