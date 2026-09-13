import type { CrewRole, DriverDocumentType, Gender, LoadedOnValue, Regime } from "@corridor/domain";
import { resolveLoadedOn } from "@corridor/domain";
import type { ManifestPayload, ManifestParty, ManifestPlate } from "./types";

/** Minimal structural input — the API passes its loaded movement + org. */
export interface ManifestSource {
  organization: {
    name: string;
    usDotNumber: string | null;
    filerCode: string | null;
    scacCode: string | null;
    canadianCarrierCode: string | null;
    timezone: string;
  };
  movement: {
    regime: Regime;
    movementNumber: string;
    tripNumber: string | null;
    carrierCode: string | null;
    port: { code: string; name?: string } | null;
    scheduledCrossingAt: Date | string | null;
    isEmpty: boolean;
    iitIndicator: "none" | "iit_carrier_bond" | "iit_importer_bond";
    aciLvs: boolean;
    aciPostal: boolean;
    aciFlyingTruck: boolean;
    aciInTransit: boolean;
    aciIit: boolean;
  };
  crew: Array<{
    role: CrewRole;
    firstName: string;
    lastName: string;
    gender: Gender | null;
    licenseNumber: string | null;
    licenseJurisdiction: string | null;
    citizenship: string | null;
    /** ISO date (YYYY-MM-DD) — drivers.date_of_birth is a Drizzle `date` column,
     * which comes back as a plain string, not a `Date`. */
    dateOfBirth: string | null;
    hazmatEndorsement: boolean;
    documents: Array<{
      documentType: DriverDocumentType;
      documentNumber: string;
      issuingCountry: string | null;
      issuingState: string | null;
      expiresOn: string | null;
    }>;
  }>;
  truck: {
    unitNumber: string;
    vin: string | null;
    plateNumber: string;
    plateJurisdiction: string;
    dotNumber: string | null;
    truckType: string;
    insurancePolicyNumber: string | null;
    insuranceCompany: string | null;
    insuranceAmount: number | null;
    insuranceYear: number | null;
    plates: SourcePlate[];
    /** Seal numbers recorded on the tractor (movement_trailer_id null). */
    seals: string[];
  } | null;
  /** In tow order, each with the seals recorded on it. */
  trailers: Array<{
    /** movement_trailers.id — the slot, matched against shipments[].loadedOn. */
    movementTrailerId: string;
    unitNumber: string;
    trailerType: string;
    plateNumber: string;
    plateJurisdiction: string;
    plates: SourcePlate[];
    seals: string[];
  }>;
  shipments: Array<{
    controlNumber: string;
    shipmentType: string | null;
    cargoType: string | null;
    entryNumber: string | null;
    entryPortCode: string | null;
    inBondEntryType: string | null;
    inBondDestinationPortCode: string | null;
    inBondNumber: string | null;
    loadingCountry: string | null;
    loadingProvince: string | null;
    loadingCity: string | null;
    deliveryAddress: PostalAddress | null;
    shipperName: string | null;
    shipperAddress: PostalAddress | null;
    consigneeName: string | null;
    consigneeAddress: PostalAddress | null;
    /** Which unit the cargo rides on (0051) — null = unspecified/default. */
    loadedOn: LoadedOnValue;
    commodities: Array<{
      commodityDescription: string;
      hsCode: string | null;
      quantity: number | null;
      quantityUnit: string | null;
      weightKg: number | null;
      weightUnit: "KG" | "LB" | null;
      packagingType: string | null;
      marksAndNumbers: string | null;
      countryOfOrigin: string | null;
      valueAmount: number | null;
      valueCurrency: string | null;
      hazmat: Array<{ unCode: string; description: string | null }>;
    }>;
  }>;
}

interface SourcePlate {
  plateNumber: string;
  jurisdiction: string;
}

const plates = (rows: SourcePlate[]): ManifestPlate[] =>
  rows.map((p) => ({ plate: p.plateNumber, jurisdiction: p.jurisdiction }));

interface PostalAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

/** One printable line, the way a manifest prints an address. */
function formatAddress(address: PostalAddress | null | undefined): string | null {
  const parts = [
    address?.line1,
    address?.line2,
    address?.city,
    address?.region,
    address?.postalCode,
    address?.country,
  ].filter((p): p is string => !!p && p.trim().length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * The structured half of an address — same parts `formatAddress` prints as
 * one line, and null under the exact same condition `formatAddress` returns
 * null for (every part blank/absent). This matters because the real loaders
 * (`nestAddress`/`addressFromColumns`, `partnerAddressJson`) always hand back
 * an object — `{}` / all-null-fields when there is no address on file, never
 * JS `null` — so without this check `postal`/`delivery` would never collapse
 * to `null` for real "no address" data even though `address` (the string)
 * does, leaving a consumer no reliable way to test "is there an address".
 */
function postalOf(address: PostalAddress | null | undefined): ManifestParty["postal"] {
  if (formatAddress(address) === null) return null;
  return {
    line1: address?.line1 ?? null,
    line2: address?.line2 ?? null,
    city: address?.city ?? null,
    region: address?.region ?? null,
    postalCode: address?.postalCode ?? null,
    country: address?.country ?? null,
  };
}

const party = (name: string | null, address: PostalAddress | null): ManifestParty | null =>
  name ? { name, address: formatAddress(address), postal: postalOf(address) } : null;

export function buildManifest(src: ManifestSource): ManifestPayload {
  if (!src.crew.some((c) => c.role === "person_in_charge"))
    throw new Error("manifest requires a person in charge");
  if (!src.truck) throw new Error("manifest requires a truck");
  if (!src.movement.port) throw new Error("manifest requires a port of entry");
  if (!src.movement.carrierCode) throw new Error("manifest requires a carrier code");
  if (!src.movement.scheduledCrossingAt) throw new Error("manifest requires an ETA");
  if (src.shipments.length === 0 && !src.movement.isEmpty)
    throw new Error("manifest requires at least one shipment");
  if (src.shipments.length > 0 && src.movement.isEmpty)
    throw new Error("an empty trip cannot carry shipments");

  const loadedOnUnits = {
    truckUnitNumber: src.truck.unitNumber,
    trailers: src.trailers.map((t) => ({ id: t.movementTrailerId, unitNumber: t.unitNumber })),
  };

  const eta =
    typeof src.movement.scheduledCrossingAt === "string"
      ? src.movement.scheduledCrossingAt
      : src.movement.scheduledCrossingAt.toISOString();

  return {
    regime: src.movement.regime,
    carrier: {
      code: src.movement.carrierCode,
      filerCode: src.organization.filerCode,
      usDotNumber: src.organization.usDotNumber,
      name: src.organization.name,
      scac: src.organization.scacCode,
      canadianCarrierCode: src.organization.canadianCarrierCode,
      timezone: src.organization.timezone,
    },
    trip: {
      movementNumber: src.movement.movementNumber,
      tripNumber: src.movement.tripNumber,
      portOfEntry: src.movement.port.code,
      estimatedArrival: eta,
      isEmpty: src.movement.isEmpty,
      iitIndicator: src.movement.iitIndicator,
      aci: {
        lvs: src.movement.aciLvs,
        postal: src.movement.aciPostal,
        flyingTruck: src.movement.aciFlyingTruck,
        inTransit: src.movement.aciInTransit,
        iit: src.movement.aciIit,
      },
    },
    crew: src.crew.map((c) => ({
      role: c.role,
      firstName: c.firstName,
      lastName: c.lastName,
      gender: c.gender,
      licenseNumber: c.licenseNumber,
      licenseJurisdiction: c.licenseJurisdiction,
      citizenship: c.citizenship,
      dateOfBirth: c.dateOfBirth,
      hazmatEndorsement: c.hazmatEndorsement,
      documents: c.documents.map((d) => ({
        type: d.documentType,
        number: d.documentNumber,
        issuingCountry: d.issuingCountry,
        issuingState: d.issuingState,
        expiresOn: d.expiresOn,
      })),
    })),
    conveyance: {
      unitNumber: src.truck.unitNumber,
      vin: src.truck.vin,
      plate: src.truck.plateNumber,
      plateJurisdiction: src.truck.plateJurisdiction,
      plates: plates(src.truck.plates),
      truckType: src.truck.truckType,
      dotNumber: src.truck.dotNumber,
      insurance:
        src.truck.insuranceCompany ||
        src.truck.insurancePolicyNumber ||
        src.truck.insuranceAmount != null ||
        src.truck.insuranceYear != null
          ? {
              company: src.truck.insuranceCompany,
              policyNumber: src.truck.insurancePolicyNumber,
              amount: src.truck.insuranceAmount,
              year: src.truck.insuranceYear,
            }
          : null,
      seals: src.truck.seals,
    },
    equipment: src.trailers.map((t) => ({
      unitNumber: t.unitNumber,
      type: t.trailerType,
      plate: t.plateNumber,
      plateJurisdiction: t.plateJurisdiction,
      plates: plates(t.plates),
      seals: t.seals,
    })),
    shipments: src.shipments.map((s) => {
      const resolved = resolveLoadedOn(loadedOnUnits, s.loadedOn);
      if (resolved.type === "ambiguous")
        throw new Error(
          `shipment ${s.controlNumber}: more than one trailer is attached and loadedOn is not set`,
        );
      if (resolved.type === "stale")
        throw new Error(
          `shipment ${s.controlNumber}: loadedOn names a unit that is not on this trip`,
        );
      return {
        controlNumber: s.controlNumber,
        shipmentType: s.shipmentType,
        cargoType: s.cargoType,
        entryNumber: s.entryNumber,
        entryPort: s.entryPortCode,
        inBond: s.inBondEntryType
          ? {
              entryType: s.inBondEntryType,
              destinationPort: s.inBondDestinationPortCode,
              number: s.inBondNumber,
            }
          : null,
        loading: {
          country: s.loadingCountry,
          province: s.loadingProvince,
          city: s.loadingCity,
        },
        delivery: postalOf(s.deliveryAddress),
        shipper: party(s.shipperName, s.shipperAddress),
        consignee: party(s.consigneeName, s.consigneeAddress),
        // Only ever the filer's explicit choice — an implicit default is left
        // unset so the mapper never emits a guess (see loaded-on.ts in ace.ts).
        loadedOn: resolved.explicit ? { type: resolved.type, unitNumber: resolved.unitNumber } : null,
        commodities: s.commodities.map((c) => ({
          description: c.commodityDescription,
          hsCode: c.hsCode,
          quantity: c.quantity,
          quantityUnit: c.quantityUnit,
          weightKg: c.weightKg,
          weightUnit: c.weightUnit,
          packagingType: c.packagingType,
          marksAndNumbers: c.marksAndNumbers,
          hazmat: c.hazmat.map((h) => ({ unCode: h.unCode, description: h.description })),
          countryOfOrigin: c.countryOfOrigin,
          value:
            c.valueAmount != null && c.valueCurrency
              ? { amount: c.valueAmount, currency: c.valueCurrency }
              : null,
        })),
      };
    }),
  };
}
