/**
 * Every reason a `ManifestPayload` can't be filed with BorderConnect, in one
 * pass. `toAceTrip`/`toAciTrip` call this first and throw a single 422 naming
 * every problem at once (never one throw per rule) — see the header of the
 * task-5 plan for why: a filer fixing a manifest wants the whole list, not a
 * fix-one-resubmit-find-the-next loop.
 */
import type { ManifestPayload, ManifestParty } from "../types";
import { CustomsTransportError } from "../types";
import { tripNumberFor } from "./format";
import {
  ACE_SHIPMENT_TYPE_MAP,
  findAcePackagingUnit,
  findAciPackagingUnit,
  mappedDriverDocuments,
  mapTrailerType,
} from "./code-lists";
import { LOADED_ON_NUMBER } from "./loaded-on";

const ACE_CONTROL_NUMBER = /^[A-Z]{4}[A-Z0-9]{4,12}$/;

/** Same "printed line" a party would produce — mirrors `buildAddress` in `ace.ts`. */
function addressLineOf(party: ManifestParty | null): string {
  return [party?.postal?.line1, party?.postal?.line2].filter((p): p is string => !!p).join(" ");
}

function validateParty(path: string, party: ManifestParty | null, problems: string[]): void {
  if (!party?.name) problems.push(`${path}.name: required`);
  if (!addressLineOf(party)) problems.push(`${path}.addressLine: required`);
  if (!party?.postal?.city) problems.push(`${path}.city: required`);
  if (!party?.postal?.postalCode) problems.push(`${path}.postalCode: required`);
}

export function validateForBorderConnect(m: ManifestPayload): string[] {
  const problems: string[] = [];

  try {
    tripNumberFor(m);
  } catch (e) {
    if (e instanceof CustomsTransportError) problems.push(e.message);
    else throw e;
  }

  if (m.regime === "ACE" && !m.conveyance.vin) {
    problems.push("conveyance.vin: required for ACE");
  }

  m.equipment.forEach((t, i) => {
    if (!mapTrailerType(t.type)) {
      problems.push(`equipment[${i}].type: no BorderConnect trailer type for ${t.type}`);
    }
  });

  const drivers = m.crew.filter((c) => c.role === "person_in_charge" || c.role === "crew_member");
  if (m.regime === "ACE" && drivers.length === 0) {
    problems.push("crew: ACE requires at least one driver");
  }

  if (m.regime === "ACE") {
    // `dateOfBirth`/`citizenshipCountry` are mandatory on an ACE driver, same
    // as on a passenger. Without this, `buildDriver` (ace.ts) happily emits
    // `dateOfBirth: null, citizenshipCountry: null` for an incomplete driver
    // record — a silently incomplete filing, which is exactly what this
    // adapter refuses to do: throw loudly, never ship a mismapped field.
    drivers.forEach((d, i) => {
      const missing: string[] = [];
      if (!d.dateOfBirth) missing.push("dateOfBirth");
      if (!d.citizenship) missing.push("citizenshipCountry");
      if (missing.length > 0) {
        problems.push(`drivers[${i}]: missing ${missing.join(", ")}`);
      }
    });

    m.crew
      .filter((c) => c.role === "passenger")
      .forEach((p, i) => {
        const missing: string[] = [];
        if (p.gender !== "M" && p.gender !== "F") missing.push("gender");
        if (!p.dateOfBirth) missing.push("dateOfBirth");
        if (!p.citizenship) missing.push("citizenshipCountry");
        // Counted after the mapper's own filter, not `p.documents.length`: a
        // passenger carrying only a type BorderConnect has no confirmed code
        // for (`permanent_resident_card`, `us_alien_registration`, `fast` —
        // see DRIVER_DOCUMENT_TYPE_MAP) would otherwise pass here and ship an
        // empty `travelDocuments` array.
        if (mappedDriverDocuments(p.documents).length === 0) missing.push("travelDocuments");
        if (missing.length > 0) {
          problems.push(`passengers[${i}]: missing ${missing.join(", ")}`);
        }
      });
  }

  m.shipments.forEach((s, i) => {
    if (!ACE_CONTROL_NUMBER.test(s.controlNumber) && m.regime === "ACE") {
      problems.push(
        `shipments[${i}].controlNumber: must be 4 letters followed by 4-12 alphanumerics`,
      );
    }

    if (m.regime === "ACE") {
      const type = s.shipmentType;
      if (!type || !(type in ACE_SHIPMENT_TYPE_MAP)) {
        problems.push(`shipments[${i}].shipmentType: no BorderConnect shipment type for ${type}`);
      }
      if (!s.loading.province) {
        problems.push(`shipments[${i}].loading.province: required (provinceOfLoading)`);
      }
      if (s.shipmentType === "in_bond") {
        problems.push(`shipments[${i}].inBond: irsNumber/fda not captured yet`);
      }
    } else {
      if (!s.loading.city) {
        problems.push(`shipments[${i}].loading.city: required (cityOfLoading.cityName)`);
      }
      if (!s.loading.province) {
        problems.push(`shipments[${i}].loading.province: required (cityOfLoading.stateProvince)`);
      }
      if (!resolveAciShipmentType(s)) {
        problems.push(
          `shipments[${i}].shipmentType: a plain non-PARS ACI shipment has no confirmed BorderConnect type (open risk)`,
        );
      }
    }

    validateParty(`shipments[${i}].shipper`, s.shipper, problems);
    validateParty(`shipments[${i}].consignee`, s.consignee, problems);

    // 0051 — loadedOn. buildManifest already refuses to build a payload that
    // is ambiguous or names a unit off the trip, so this mainly guards a
    // ManifestPayload assembled without going through it (as several tests
    // do) and the one thing buildManifest cannot check: whether the wire
    // string itself is shaped the way BorderConnect's manuals require.
    if (!s.loadedOn && m.equipment.length > 1) {
      problems.push(`shipments[${i}].loadedOn: required when more than one trailer is attached`);
    } else if (s.loadedOn) {
      const known =
        s.loadedOn.type === "TRUCK"
          ? s.loadedOn.unitNumber === m.conveyance.unitNumber
          : m.equipment.some((t) => t.unitNumber === s.loadedOn!.unitNumber);
      if (!known) {
        problems.push(
          `shipments[${i}].loadedOn.number: ${s.loadedOn.unitNumber} is not a unit on this trip`,
        );
      }
      if (!LOADED_ON_NUMBER.test(s.loadedOn.unitNumber)) {
        problems.push(
          `shipments[${i}].loadedOn.number: must be 1-17 characters of A-Z 0-9 space - / \\`,
        );
      }
    }

    s.commodities.forEach((c, j) => {
      if (c.quantity == null) problems.push(`shipments[${i}].commodities[${j}].quantity: required`);
      if (c.weightKg == null) problems.push(`shipments[${i}].commodities[${j}].weight: required`);
      const packagingLookup = m.regime === "ACE" ? findAcePackagingUnit : findAciPackagingUnit;
      if (!c.packagingType || !packagingLookup(c.packagingType)) {
        problems.push(
          `shipments[${i}].commodities[${j}].packagingUnit: no BorderConnect packaging unit for ${c.packagingType}`,
        );
      }
      if (m.regime === "ACE" && c.hazmat.length > 0) {
        problems.push(
          `shipments[${i}].commodities[${j}].hazmat: BorderConnect requires an emergency contact Corridor does not capture yet`,
        );
      }
    });
  });

  if (m.regime === "ACI") {
    (["lvs", "postal", "flyingTruck", "inTransit", "iit"] as const).forEach((flag) => {
      if (m.trip.aci[flag]) {
        problems.push(`trip.aci.${flag}: not representable in the BorderConnect eManifest API`);
      }
    });
  }

  return problems;
}

/**
 * ACI's `shipmentType`/`isPars` resolution (0022 JSON manual, "ACI_SHIPMENT"):
 * `isPars` is not on the payload at all — a PARS shipment is recognised by
 * its control number or by `cargoType`. Returns `undefined` when none of the
 * documented cases apply (a "plain" non-PARS regular shipment) — the
 * validator 422s that case as an open risk, never guesses.
 */
export function resolveAciShipmentType(
  s: ManifestPayload["shipments"][number],
): { code: string; consolidatedFreight?: true } | undefined {
  if (s.cargoType === "csa") return { code: "CSA" };
  if (s.cargoType === "a49") return { code: "A49" };
  if (s.cargoType === "e29b") return { code: "E29B" };
  if (s.shipmentType === "in_bond") return { code: "BOND" };
  if (s.cargoType === "consolidated") return { code: "PARS", consolidatedFreight: true };
  if (s.cargoType === "regular" && s.controlNumber.includes("PARS")) return { code: "PARS" };
  return undefined;
}
