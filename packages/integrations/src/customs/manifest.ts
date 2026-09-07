import type { Regime } from "@corridor/domain";
import type { ManifestPayload } from "./types";

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
  };
  driver: {
    firstName: string;
    lastName: string;
    licenseNumber: string;
    licenseJurisdiction: string;
    citizenship: string | null;
    fastCardNumber: string | null;
  } | null;
  truck: {
    unitNumber: string;
    vin: string | null;
    plateNumber: string;
    plateJurisdiction: string;
  } | null;
  trailer: { unitNumber: string; plateNumber: string; plateJurisdiction: string } | null;
  seals: Array<{ sealNumber: string }>;
  cargo: Array<{
    lineNumber: number;
    shipperName: string | null;
    consigneeName: string | null;
    commodityDescription: string;
    hsCode: string | null;
    weightKg: number | null;
    pieceCount: number | null;
    valueAmount: number | null;
    valueCurrency: string | null;
    countryOfOrigin: string | null;
  }>;
}

export function buildManifest(src: ManifestSource): ManifestPayload {
  if (!src.driver) throw new Error("manifest requires a driver");
  if (!src.truck) throw new Error("manifest requires a truck");
  if (!src.movement.port) throw new Error("manifest requires a port of entry");
  if (!src.movement.carrierCode) throw new Error("manifest requires a carrier code");
  if (!src.movement.scheduledCrossingAt) throw new Error("manifest requires an ETA");

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
    },
    crew: [
      {
        role: "driver",
        firstName: src.driver.firstName,
        lastName: src.driver.lastName,
        licenseNumber: src.driver.licenseNumber,
        licenseJurisdiction: src.driver.licenseJurisdiction,
        citizenship: src.driver.citizenship,
        fastCardNumber: src.driver.fastCardNumber,
      },
    ],
    conveyance: {
      unitNumber: src.truck.unitNumber,
      vin: src.truck.vin,
      plate: src.truck.plateNumber,
      plateJurisdiction: src.truck.plateJurisdiction,
    },
    equipment: src.trailer
      ? [
          {
            unitNumber: src.trailer.unitNumber,
            plate: src.trailer.plateNumber,
            plateJurisdiction: src.trailer.plateJurisdiction,
            seals: src.seals.map((s) => s.sealNumber),
          },
        ]
      : [],
    shipments: src.cargo.map((c) => ({
      lineNumber: c.lineNumber,
      shipper: c.shipperName,
      consignee: c.consigneeName,
      commodity: c.commodityDescription,
      hsCode: c.hsCode,
      weightKg: c.weightKg,
      pieceCount: c.pieceCount,
      value:
        c.valueAmount != null && c.valueCurrency
          ? { amount: c.valueAmount, currency: c.valueCurrency }
          : null,
      countryOfOrigin: c.countryOfOrigin,
    })),
  };
}
