import type { CrewRole, DriverDocumentType, Gender, Regime } from "@corridor/domain";
import type { ManifestPayload, ManifestParty, ManifestPlate } from "./types";

/** Minimal structural input — the API passes its loaded movement + org. */
export interface ManifestSource {
  organization: {
    name: string;
    usDotNumber: string | null;
    filerCode: string | null;
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
    shipperName: string | null;
    shipperAddress: PostalAddress | null;
    consigneeName: string | null;
    consigneeAddress: PostalAddress | null;
    commodities: Array<{
      commodityDescription: string;
      hsCode: string | null;
      quantity: number | null;
      quantityUnit: string | null;
      weightKg: number | null;
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

const party = (name: string | null, address: PostalAddress | null): ManifestParty | null =>
  name ? { name, address: formatAddress(address) } : null;

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
    shipments: src.shipments.map((s) => ({
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
      shipper: party(s.shipperName, s.shipperAddress),
      consignee: party(s.consigneeName, s.consigneeAddress),
      commodities: s.commodities.map((c) => ({
        description: c.commodityDescription,
        hsCode: c.hsCode,
        quantity: c.quantity,
        quantityUnit: c.quantityUnit,
        weightKg: c.weightKg,
        marksAndNumbers: c.marksAndNumbers,
        hazmat: c.hazmat.map((h) => ({ unCode: h.unCode, description: h.description })),
        countryOfOrigin: c.countryOfOrigin,
        value:
          c.valueAmount != null && c.valueCurrency
            ? { amount: c.valueAmount, currency: c.valueCurrency }
            : null,
      })),
    })),
  };
}
