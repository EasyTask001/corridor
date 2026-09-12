/**
 * `ManifestPayload` → BorderConnect `ACI_TRIP` (the CBSA eManifest JSON
 * message). Shipper/consignee/address/driver shapes are documented as
 * identical to ACE's, so this reuses `buildParty`/`buildAddress`/
 * `buildLicensePlates`/`buildDriver` from `ace.ts` rather than duplicating
 * them.
 */
import type { ManifestPayload } from "../types";
import { CustomsTransportError } from "../types";
import { bcDateTime, tripNumberFor, type OutboundOptions } from "./format";
import { findAciPackagingUnit, mapTrailerType } from "./code-lists";
import { validateForBorderConnect, resolveAciShipmentType } from "./validate";
import { buildAddress, buildDriver, buildLicensePlates, buildParty } from "./ace";

function buildAciCommodity(c: ManifestPayload["shipments"][number]["commodities"][number]): Record<string, unknown> {
  return {
    description: c.description,
    quantity: c.quantity,
    packagingUnit: findAciPackagingUnit(c.packagingType ?? ""),
    weight: c.weightKg,
    weightUnit: "KG",
    ...(c.marksAndNumbers ? { marksAndNumbers: c.marksAndNumbers } : {}),
    ...(c.hsCode ? { harmonizedCode: c.hsCode } : {}),
    ...(c.value ? { value: { amount: c.value.amount, currency: c.value.currency } } : {}),
    ...(c.countryOfOrigin ? { countryOfOrigin: c.countryOfOrigin } : {}),
  };
}

function buildAciShipment(
  s: ManifestPayload["shipments"][number],
  companyKey: string,
  portOfEntry: string,
  estimatedArrivalDate: string,
): Record<string, unknown> {
  // Guaranteed resolvable — validateForBorderConnect already 422s otherwise.
  const resolved = resolveAciShipmentType(s)!;
  return {
    data: "ACI_SHIPMENT",
    companyKey,
    cargoControlNumber: s.controlNumber,
    shipmentType: resolved.code,
    ...(resolved.consolidatedFreight ? { consolidatedFreight: true } : {}),
    portOfEntry,
    releaseOffice: portOfEntry,
    estimatedArrivalDate,
    cityOfLoading: { cityName: s.loading.city, stateProvince: s.loading.province },
    shipper: buildParty(s.shipper),
    consignee: buildParty(s.consignee),
    ...(s.delivery
      ? {
          deliveryDestinations: [
            { name: s.consignee?.name ?? null, address: buildAddress(s.delivery) },
          ],
        }
      : {}),
    commodities: s.commodities.map(buildAciCommodity),
  };
}

/**
 * Builds an `ACI_TRIP` send-request body. Throws a 422 `CustomsTransportError`
 * naming every unmet BorderConnect requirement at once (see `validate.ts`).
 */
export function toAciTrip(m: ManifestPayload, o: OutboundOptions): Record<string, unknown> {
  const problems = validateForBorderConnect(m);
  if (problems.length > 0) {
    throw new CustomsTransportError(
      `BorderConnect: manifest is missing ${problems.length} required field(s): ${problems.join("; ")}`,
      422,
      false,
    );
  }

  const tripNumber = o.tripNumberOverride ?? tripNumberFor(m);
  const portOfEntry = m.trip.portOfEntry.padStart(4, "0");
  const estimatedArrivalDate = bcDateTime(m.trip.estimatedArrival, m.carrier.timezone);

  return {
    data: "ACI_TRIP",
    sendId: o.sendId,
    companyKey: o.companyKey,
    operation: o.operation,
    autoSend: o.autoSend,
    tripNumber,
    estimatedArrivalDate,
    portOfEntry,
    truck: {
      number: m.conveyance.unitNumber,
      licensePlate: { number: m.conveyance.plate, stateProvince: m.conveyance.plateJurisdiction },
      ...(m.conveyance.truckType ? { type: m.conveyance.truckType } : {}),
      ...(m.conveyance.vin ? { vinNumber: m.conveyance.vin } : {}),
      sealNumbers: m.conveyance.seals,
      ...(m.conveyance.dotNumber ? { dotNumber: m.conveyance.dotNumber } : {}),
    },
    trailers: m.equipment.map((t) => ({
      number: t.unitNumber,
      type: mapTrailerType(t.type),
      licensePlates: buildLicensePlates({ plate: t.plate, plateJurisdiction: t.plateJurisdiction }, t.plates),
      sealNumbers: t.seals,
    })),
    drivers: m.crew
      .filter((c) => c.role === "person_in_charge" || c.role === "crew_member")
      .map(buildDriver),
    shipments: m.shipments.map((s) => buildAciShipment(s, o.companyKey, portOfEntry, estimatedArrivalDate)),
  };
}
