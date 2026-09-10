import type { AvaalCategory, AvaalFieldValue, AvaalSnapshot, AvaalUiRecord } from "./snapshot";
import {
  MigrationException,
  mapMovementStatus,
  mapShipmentStatus,
  type MigrationExceptionDetails,
} from "./status-mapping";

export interface ImportAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export interface OrganizationImport {
  name: string;
  legalName: string | null;
  scacCode: string | null;
  canadianCarrierCode: string | null;
  usDotNumber: string | null;
  mcNumber: string | null;
  filerCode: string | null;
  billingEmail: string | null;
  subscriptionPlan: "trial" | "starter" | "professional" | "enterprise";
  subscriptionStatus: "trialing" | "active" | "past_due" | "canceled" | "incomplete";
  simpleDriverSheet: boolean;
  timezone: string;
  billingAddress: ImportAddress;
  includeParsInCargoNumbers: boolean;
  dispatchEmails: string[];
}

export interface CarrierCodeImport {
  sourceKey: string;
  regime: "ACE" | "ACI";
  code: string;
  isDefault: boolean;
}

export interface UserImport {
  sourceKey: string;
  loginName: string;
  email: string | null;
  displayName: string;
  phone: string | null;
  isAdmin: boolean;
}

export interface DriverImport {
  sourceKey: string;
  firstName: string;
  lastName: string;
  licenseNumber: string | null;
  licenseJurisdiction: string | null;
  dateOfBirth: string | null;
  citizenship: string | null;
  phone: string | null;
  email: string | null;
  gender: "M" | "F" | "X" | null;
  hazmatEndorsement: boolean;
  address: ImportAddress;
  smsOptIn: boolean;
  smsPhoneAce: string | null;
  smsPhoneAci: string | null;
  status: "active" | "inactive" | "archived";
}

export interface DriverDocumentImport {
  sourceKey: string;
  driverKey: string;
  documentType: string;
  documentNumber: string;
  issuingCountry: string | null;
  issuingState: string | null;
  isPrimary: boolean;
}

export interface TruckImport {
  sourceKey: string;
  unitNumber: string;
  vin: string | null;
  plateNumber: string;
  plateJurisdiction: string;
  transponderNumber: string | null;
  dotNumber: string | null;
  hazmatCapable: boolean;
  insuranceCompany: string | null;
  insurancePolicyNumber: string | null;
  insuranceAmount: number | null;
  insuranceYear: number | null;
  status: "active" | "inactive" | "archived";
}

export interface TrailerImport {
  sourceKey: string;
  unitNumber: string;
  trailerType: string;
  plateNumber: string;
  plateJurisdiction: string;
  status: "active" | "inactive" | "archived";
}

export interface EquipmentPlateImport {
  sourceKey: string;
  truckKey: string | null;
  trailerKey: string | null;
  plateNumber: string;
  jurisdiction: string;
  position: number;
}

export interface PartnerImport {
  sourceKey: string;
  sourceKeys: string[];
  name: string;
  type: "shipper" | "consignee" | "broker" | "both";
  address: ImportAddress;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  status: "active" | "inactive" | "archived";
}

export interface MovementImport {
  sourceKey: string;
  regime: "ACE" | "ACI";
  movementNumber: string;
  tripNumber: string | null;
  status: ReturnType<typeof mapMovementStatus>;
  portCode: string | null;
  carrierCode: string | null;
  scheduledCrossingLocal: string | null;
  truckKey: string | null;
  isEmpty: boolean;
  iitIndicator: "none" | "goods" | "empty";
  aciLvs: boolean;
  aciPostal: boolean;
  aciFlyingTruck: boolean;
  aciInTransit: boolean;
  aciIit: boolean;
  customsReferenceNumber: string | null;
  notes: string | null;
  sourceUpdatedAt: string | null;
}

export interface MovementCrewImport {
  sourceKey: string;
  movementKey: string;
  driverKey: string;
  role: "person_in_charge" | "crew_member" | "passenger";
  position: number;
}

export interface MovementTrailerImport {
  sourceKey: string;
  movementKey: string;
  trailerKey: string;
  position: number;
}

export interface ShipmentImport {
  sourceKey: string;
  regime: "ACE" | "ACI";
  movementKey: string | null;
  carrierCode: string;
  shipmentType: string | null;
  cargoType: string | null;
  controlReference: string;
  isPars: boolean;
  entryNumber: string | null;
  entryPortCode: string | null;
  shipperKey: string | null;
  consigneeKey: string | null;
  destinationPortCode: string | null;
  sublocationCode: string | null;
  loadingCountry: string | null;
  loadingProvince: string | null;
  loadingCity: string | null;
  deliveryAddress: ImportAddress;
  status: ReturnType<typeof mapShipmentStatus>;
  notes: string | null;
  sourceUpdatedAt: string | null;
}

export interface CommodityImport {
  sourceKey: string;
  shipmentKey: string;
  lineNumber: number;
  commodityDescription: string;
  weightKg: number | null;
  weightUnit: "KG" | "LB";
  quantity: number | null;
  quantityUnit: string | null;
  marksAndNumbers: string | null;
  isConsolidated: boolean;
}

export interface CommodityHazmatImport {
  sourceKey: string;
  commodityKey: string;
  position: number;
  unCode: string;
  description: string | null;
}

export interface SealImport {
  sourceKey: string;
  movementKey: string;
  trailerKey: string | null;
  sealNumber: string;
  sealType: string | null;
}

export interface MovementEventImport {
  sourceKey: string;
  movementKey: string;
  shipmentKey: string | null;
  eventType: "status_change" | "amendment" | "note" | "customs_response" | "customs_event";
  fromStatus: string | null;
  toStatus: string | null;
  payload: Record<string, unknown>;
  occurredAtLocal: string | null;
}

export interface CustomsSubmissionImport {
  sourceKey: string;
  movementKey: string;
  provider: "cbp_ace" | "cbsa_aci";
  referenceNumber: string | null;
  status: string;
}

export interface ExternalShipmentImport {
  sourceKey: string;
  regime: "ACE" | "ACI";
  controlNumber: string | null;
  inBondNumber: string | null;
  originatingCarrierCode: string | null;
  description: string | null;
  status: "open" | "closed";
}

export interface CorridorImportBundle {
  organization: OrganizationImport | null;
  carrierCodes: CarrierCodeImport[];
  users: UserImport[];
  notificationRules: Array<{
    sourceKey: string;
    userKey: string;
    eventType: string;
    enabled: boolean;
    channel: string[];
  }>;
  drivers: DriverImport[];
  driverDocuments: DriverDocumentImport[];
  trucks: TruckImport[];
  trailers: TrailerImport[];
  equipmentPlates: EquipmentPlateImport[];
  partners: PartnerImport[];
  movements: MovementImport[];
  movementCrew: MovementCrewImport[];
  movementTrailers: MovementTrailerImport[];
  shipments: ShipmentImport[];
  commodities: CommodityImport[];
  hazmat: CommodityHazmatImport[];
  seals: SealImport[];
  movementEvents: MovementEventImport[];
  customsSubmissions: CustomsSubmissionImport[];
  parsRnsEvents: Array<Record<string, unknown>>;
  externalShipments: ExternalShipmentImport[];
  inBondRecords: Array<Record<string, unknown>>;
  inBondEvents: Array<Record<string, unknown>>;
  exceptions: MigrationExceptionDetails[];
}

class Fields {
  private readonly used = new Set<string>();

  constructor(readonly record: AvaalUiRecord) {}

  value(...keys: string[]): AvaalFieldValue | undefined {
    for (const key of keys) {
      if (key in this.record.fields) {
        this.used.add(key);
        return this.record.fields[key];
      }
    }
    return undefined;
  }

  string(...keys: string[]): string | null {
    const value = this.value(...keys);
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value.trim() || null;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return null;
  }

  boolean(...keys: string[]): boolean {
    const value = this.value(...keys);
    if (typeof value === "boolean") return value;
    return typeof value === "string" && /^(true|yes|on|checked)$/i.test(value.trim());
  }

  rows(...keys: string[]): Array<Record<string, AvaalFieldValue>> {
    const value = this.value(...keys);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (row): row is Record<string, AvaalFieldValue> =>
        typeof row === "object" && row !== null && !Array.isArray(row),
    );
  }

  unused(): Array<[string, AvaalFieldValue]> {
    return Object.entries(this.record.fields).filter(([key]) => !this.used.has(key));
  }
}

const categoryRecords = (snapshot: AvaalSnapshot, category: AvaalCategory): AvaalUiRecord[] => {
  const value = snapshot.categories[category];
  return value && !("notApplicable" in value) ? value.records : [];
};

const compact = <T>(values: Array<T | null | undefined | "">): T[] =>
  values.filter((value): value is T => value !== null && value !== undefined && value !== "");

const normalizeIdentity = (value: string): string =>
  value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");

const countryCode = (value: string | null): string | null => {
  if (!value) return null;
  const normalized = normalizeIdentity(value);
  const known: Record<string, string> = {
    ca: "CA",
    canada: "CA",
    us: "US",
    usa: "US",
    unitedstates: "US",
    unitedstatesofamerica: "US",
    in: "IN",
    india: "IN",
  };
  return known[normalized] ?? value.trim().toUpperCase();
};

const jurisdictionCode = (value: string | null): string | null => {
  if (!value) return null;
  const normalized = normalizeIdentity(value);
  const known: Record<string, string> = {
    alberta: "AB",
    britishcolumbia: "BC",
    manitoba: "MB",
    newbrunswick: "NB",
    newfoundlandandlabrador: "NL",
    novascotia: "NS",
    ontario: "ON",
    princeedwardisland: "PE",
    quebec: "QC",
    saskatchewan: "SK",
    minnesota: "MN",
    northdakota: "ND",
    southdakota: "SD",
    wisconsin: "WI",
    illinois: "IL",
    indiana: "IN",
    michigan: "MI",
    ohio: "OH",
    newyork: "NY",
    texas: "TX",
    california: "CA",
    washington: "WA",
  };
  return known[normalized] ?? value.trim().toUpperCase();
};

const gender = (value: string | null): "M" | "F" | "X" | null => {
  if (!value) return null;
  if (/^m(?:ale)?$/i.test(value)) return "M";
  if (/^f(?:emale)?$/i.test(value)) return "F";
  return "X";
};

const documentType = (value: string | null): string => {
  const normalized = normalizeIdentity(value ?? "");
  const known: Record<string, string> = {
    passport: "passport",
    passportnumber: "passport",
    fast: "fast",
    fastcard: "fast",
    nexus: "nexus",
    nexuscard: "nexus",
    permanentresidentcard: "permanent_resident_card",
    visa: "visa_non_immigrant",
    birthcertificate: "birth_certificate",
    citizenshipcard: "citizenship_card",
  };
  return known[normalized] ?? "other";
};

const timeZone = (value: string | null): string => {
  const normalized = normalizeIdentity(value ?? "");
  const known: Record<string, string> = {
    centraltime: "America/Winnipeg",
    easterntime: "America/Toronto",
    mountaintime: "America/Edmonton",
    pacifictime: "America/Vancouver",
    atlantictime: "America/Halifax",
    newfoundlandtime: "America/St_Johns",
  };
  return known[normalized] ?? "America/Winnipeg";
};

const amount = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const integer = (value: string | null): number | null => {
  const parsed = amount(value);
  return parsed === null ? null : Math.trunc(parsed);
};

const dateAndTime = (date: string | null, time: string | null): string | null =>
  compact<string>([date, time]).join(" ") || null;

const addressFrom = (fields: Fields, prefix = ""): ImportAddress => ({
  ...compact<string>([fields.string(`${prefix}Address`, `${prefix}Address Line 1`)]).reduce(
    (result, line1) => ({ ...result, line1 }),
    {},
  ),
  ...compact<string>([fields.string(`${prefix}City`)]).reduce(
    (result, city) => ({ ...result, city }),
    {},
  ),
  ...compact<string>([fields.string(`${prefix}Province/State`)]).reduce(
    (result, region) => ({ ...result, region }),
    {},
  ),
  ...compact<string>([fields.string(`${prefix}Postal/Zip Code`)]).reduce(
    (result, postalCode) => ({ ...result, postalCode }),
    {},
  ),
  ...compact<string>([countryCode(fields.string(`${prefix}Country`))]).reduce(
    (result, country) => ({ ...result, country }),
    {},
  ),
});

const partnerIdentity = (name: string, address: ImportAddress): string =>
  [name, address.line1, address.city, address.region, address.postalCode, address.country]
    .map((part) => normalizeIdentity(part ?? ""))
    .join("|");

const rowString = (row: Record<string, AvaalFieldValue>, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value.trim() || null : null;
};

const portCode = (value: string | null): string | null => {
  if (!value) return null;
  const match = value.match(/\b[A-Z0-9]{4}\b/i);
  return match?.[0]?.toUpperCase() ?? value.trim();
};

const aceShipmentType = (value: string | null): string | null => {
  if (!value) return null;
  const known: Record<string, string> = {
    regularbill: "regular_bill",
    regular: "regular_bill",
    section321: "section_321",
    goodsastray: "goods_astray",
    inbond: "in_bond",
  };
  return known[normalizeIdentity(value)] ?? null;
};

const aciCargoType = (value: string | null): string | null => {
  if (!value) return null;
  const known: Record<string, string> = {
    regular: "regular",
    consolidated: "consolidated",
    csa: "csa",
    a49: "a49",
    e29b: "e29b",
  };
  return known[normalizeIdentity(value)] ?? null;
};

const toException = (
  category: AvaalCategory,
  record: AvaalUiRecord,
  fieldLabel: string,
  displayedValue: unknown,
  reason: string,
  blocking = false,
): MigrationExceptionDetails => ({
  category,
  sourceId: record.sourceId,
  fieldLabel,
  displayedValue,
  reason,
  blocking,
});

export const mapAvaalSnapshot = (snapshot: AvaalSnapshot): CorridorImportBundle => {
  const exceptions: MigrationExceptionDetails[] = [];
  const companyRecord = categoryRecords(snapshot, "company")[0];
  const emailPreferencesRecord = categoryRecords(snapshot, "email_preferences")[0];
  let organization: OrganizationImport | null = null;
  const carrierCodes: CarrierCodeImport[] = [];

  if (companyRecord) {
    const company = new Fields(companyRecord);
    const preferences = emailPreferencesRecord ? new Fields(emailPreferencesRecord) : null;
    const scac = company.string("SCAC Code");
    const canadianCode = company.string("Canadian Carrier Code");
    const dispatchEmails = preferences
      ? compact<string>([
          preferences.string("Email 1"),
          preferences.string("Email 2"),
          preferences.string("Email 3"),
          preferences.string("Email 4"),
          preferences.string("Email 5"),
        ])
      : [];
    organization = {
      name: company.string("Company Name") ?? "",
      legalName: company.string("Company Name"),
      scacCode: scac,
      canadianCarrierCode: canadianCode,
      usDotNumber: null,
      mcNumber: null,
      filerCode: company.string("Filer Code"),
      billingEmail: dispatchEmails[0] ?? null,
      subscriptionPlan: "enterprise",
      subscriptionStatus: "active",
      simpleDriverSheet: company.boolean("Use Simple Driver Sheet"),
      timezone: timeZone(company.string("Time Zone")),
      billingAddress: {
        line1: company.string("Billing Address") ?? undefined,
        city: company.string("Billing City") ?? undefined,
        region: company.string("Billing Province/State") ?? undefined,
        postalCode: company.string("Billing Postal/Zip Code") ?? undefined,
        country: countryCode(company.string("Billing Country")) ?? undefined,
      },
      includeParsInCargoNumbers: company.boolean("Include PARS in ACI Cargo Numbers"),
      dispatchEmails,
    };
    if (!organization.name) {
      exceptions.push(toException("company", companyRecord, "Company Name", "", "is required", true));
    }
    if (scac) {
      carrierCodes.push({
        sourceKey: `carrier:ACE:${scac}`,
        regime: "ACE",
        code: scac,
        isDefault: true,
      });
    }
    if (canadianCode) {
      carrierCodes.push({
        sourceKey: `carrier:ACI:${canadianCode}`,
        regime: "ACI",
        code: canadianCode,
        isDefault: true,
      });
    }
    for (const [key, value] of company.unused()) {
      exceptions.push(toException("company", companyRecord, key, value, "has no Corridor field"));
    }
    if (preferences) {
      for (const [key, value] of preferences.unused()) {
        exceptions.push(
          toException("email_preferences", emailPreferencesRecord!, key, value, "has no direct Corridor field"),
        );
      }
    }
  }

  const users = categoryRecords(snapshot, "users").map((record): UserImport => {
    const fields = new Fields(record);
    const first = fields.string("First Name", "FirstName") ?? "";
    const middle = fields.string("Middle Name") ?? "";
    const last = fields.string("Last Name", "LastName") ?? "";
    const user = {
      sourceKey: record.sourceId,
      loginName: fields.string("Login Name") ?? "",
      email: fields.string("Email"),
      displayName: compact<string>([first, middle, last]).join(" "),
      phone: fields.string("Cell Phone", "Phone"),
      isAdmin: fields.boolean("Is Admin"),
    };
    for (const [key, value] of fields.unused()) {
      exceptions.push(toException("users", record, key, value, "has no direct Corridor field"));
    }
    return user;
  });

  const drivers = categoryRecords(snapshot, "drivers").map((record): DriverImport => {
    const fields = new Fields(record);
    const driver = {
      sourceKey: record.sourceId,
      firstName: fields.string("First Name") ?? "",
      lastName: fields.string("Last Name") ?? "",
      licenseNumber: fields.string("Driver License", "License #/Country"),
      licenseJurisdiction: jurisdictionCode(fields.string("Licensed Province/State", "State")),
      dateOfBirth: fields.string("Date of Birth"),
      citizenship: countryCode(fields.string("Citizenship/Nationality", "Citizenship")),
      phone: fields.string("Phone"),
      email: fields.string("Email"),
      gender: gender(fields.string("Gender")),
      hazmatEndorsement: !/^(?:none|no)?$/i.test(fields.string("HAZ-MAT Endorsements") ?? "none"),
      address: {
        line1: fields.string("Address Line 1", "Address") ?? undefined,
        city: fields.string("City") ?? undefined,
        region: fields.string("Address Province/State", "State") ?? undefined,
        postalCode: fields.string("Postal/Zip Code") ?? undefined,
        country: countryCode(fields.string("Address Country", "Country")) ?? undefined,
      },
      smsOptIn: fields.boolean("Send Entry Number SMS"),
      smsPhoneAce: fields.string("Canada Cell Phone"),
      smsPhoneAci: fields.string("USA Cell Phone"),
      status: "active" as const,
    };
    for (const [key, value] of fields.unused()) {
      exceptions.push(toException("drivers", record, key, value, "has no direct Corridor field"));
    }
    return driver;
  });

  const driverDocuments: DriverDocumentImport[] = [];
  for (const record of categoryRecords(snapshot, "drivers")) {
    const fields = new Fields(record);
    const number = fields.string("Travel Document Number");
    if (number) {
      driverDocuments.push({
        sourceKey: `${record.sourceId}:document:1`,
        driverKey: record.sourceId,
        documentType: documentType(fields.string("Travel Document Type")),
        documentNumber: number,
        issuingCountry: countryCode(fields.string("Travel Document Country")),
        issuingState: null,
        isPrimary: true,
      });
    }
  }

  const trucks = categoryRecords(snapshot, "trucks").map((record): TruckImport => {
    const fields = new Fields(record);
    const truck = {
      sourceKey: record.sourceId,
      unitNumber: fields.string("Truck Number") ?? "",
      vin: fields.string("VIN Number", "Vin Number"),
      plateNumber: fields.string("License Plate Number", "License Plate") ?? "",
      plateJurisdiction: jurisdictionCode(
        fields.string("License Plate Province/State", "State"),
      ) ?? "",
      transponderNumber: fields.string("Transponder ID"),
      dotNumber: fields.string("DOT Number"),
      hazmatCapable: fields.boolean("Transports Hazardous Materials"),
      insuranceCompany: fields.string("Insurance Company Name"),
      insurancePolicyNumber: fields.string("Insurance Policy Number"),
      insuranceAmount: amount(fields.string("Insurance Policy Amount")),
      insuranceYear: integer(fields.string("Insurance Issue Year")),
      status: "active" as const,
    };
    for (const [key, value] of fields.unused()) {
      exceptions.push(toException("trucks", record, key, value, "has no direct Corridor field"));
    }
    return truck;
  });

  const trailers = categoryRecords(snapshot, "trailers").map((record): TrailerImport => {
    const fields = new Fields(record);
    const displayedType = fields.string("Trailer Type") ?? "";
    const trailer = {
      sourceKey: record.sourceId,
      unitNumber: fields.string("Trailer Number") ?? "",
      trailerType: /semi/i.test(displayedType) ? "TF" : "TE",
      plateNumber: fields.string("License Plate Number", "License Plate") ?? "",
      plateJurisdiction: jurisdictionCode(
        fields.string("License Plate Province/State", "State"),
      ) ?? "",
      status: "active" as const,
    };
    for (const [key, value] of fields.unused()) {
      exceptions.push(toException("trailers", record, key, value, "has no direct Corridor field"));
    }
    return trailer;
  });

  const partnersByIdentity = new Map<string, PartnerImport>();
  for (const [category, type] of [
    ["shippers", "shipper"],
    ["consignees", "consignee"],
  ] as const) {
    for (const record of categoryRecords(snapshot, category)) {
      const fields = new Fields(record);
      const name = fields.string("Name") ?? "";
      const address = addressFrom(fields);
      const identity = partnerIdentity(name, address);
      const prior = partnersByIdentity.get(identity);
      if (prior) {
        prior.sourceKeys.push(record.sourceId);
        if (prior.type !== type) prior.type = "both";
      } else {
        partnersByIdentity.set(identity, {
          sourceKey: record.sourceId,
          sourceKeys: [record.sourceId],
          name,
          type,
          address,
          contactName: fields.string("Contact"),
          contactEmail: fields.string("Email"),
          contactPhone: fields.string("Phone"),
          status: "active",
        });
      }
      for (const [key, value] of fields.unused()) {
        exceptions.push(toException(category, record, key, value, "has no direct Corridor field"));
      }
    }
  }
  const partners = [...partnersByIdentity.values()];

  const truckByUnit = new Map(trucks.map((truck) => [normalizeIdentity(truck.unitNumber), truck.sourceKey]));
  const trailerByUnit = new Map(
    trailers.map((trailer) => [normalizeIdentity(trailer.unitNumber), trailer.sourceKey]),
  );
  const driverByLicense = new Map(
    drivers
      .filter((driver) => driver.licenseNumber)
      .map((driver) => [normalizeIdentity(driver.licenseNumber!), driver.sourceKey]),
  );
  const driverByName = new Map(
    drivers.map((driver) => [normalizeIdentity(`${driver.firstName} ${driver.lastName}`), driver.sourceKey]),
  );

  const movements: MovementImport[] = [];
  const movementCrew: MovementCrewImport[] = [];
  const movementTrailers: MovementTrailerImport[] = [];
  const seals: SealImport[] = [];
  const movementEvents: MovementEventImport[] = [];

  const addMovements = (category: "ace_manifests" | "aci_trips", regime: "ACE" | "ACI") => {
    for (const record of categoryRecords(snapshot, category)) {
      const fields = new Fields(record);
      const movementNumber =
        fields.string(regime === "ACE" ? "Trip Number" : "Trip #/CRN") ?? record.sourceId;
      const detailTripNumber = fields.string("Trip Number", "Trip#");
      const statusValue = fields.string("Status") ?? "";
      const truckRows = fields.rows("Trucks");
      const crewRows = fields.rows("Crew");
      const equipmentRows = fields.rows("Equipment", "Empty Equipment");
      const sealRows = fields.rows("Seals");
      const eventRows = fields.rows("Event History");
      const truckUnit = rowString(truckRows[0] ?? {}, "Truck Number");
      const carrier = fields.string(regime === "ACE" ? "SCAC" : "Carrier Code");
      const movement: MovementImport = {
        sourceKey: record.sourceId,
        regime,
        movementNumber,
        tripNumber: detailTripNumber,
        status: mapMovementStatus(statusValue),
        portCode: portCode(
          fields.string(regime === "ACE" ? "Port Code" : "Arrival Port", "Port"),
        ),
        carrierCode: carrier,
        scheduledCrossingLocal: dateAndTime(
          fields.string("Arrival Date", "Arrival Date/Time"),
          fields.string("Arrival Time"),
        ),
        truckKey: truckUnit ? truckByUnit.get(normalizeIdentity(truckUnit)) ?? null : null,
        isEmpty: fields.boolean("Empty Trip"),
        iitIndicator: fields.string("IIT Type") && !/none/i.test(fields.string("IIT Type")!)
          ? "goods"
          : "none",
        aciLvs: fields.boolean("LVS"),
        aciPostal: fields.boolean("Postal"),
        aciFlyingTruck: fields.boolean("Flying Trucks"),
        aciInTransit: fields.boolean("In Transit"),
        aciIit: fields.boolean("IIT"),
        customsReferenceNumber: null,
        notes: fields.string("Note", "Notes"),
        sourceUpdatedAt: fields.string("Last Update"),
      };
      movements.push(movement);

      crewRows.forEach((row, index) => {
        const license = rowString(row, "License Number");
        const name = rowString(row, "Name");
        const driverKey =
          (license && driverByLicense.get(normalizeIdentity(license))) ||
          (name && driverByName.get(normalizeIdentity(name))) ||
          null;
        if (!driverKey) {
          exceptions.push(
            toException(category, record, "Crew", row, "does not resolve to a captured driver; crew link omitted", false),
          );
          return;
        }
        movementCrew.push({
          sourceKey: `${record.sourceId}:crew:${index + 1}`,
          movementKey: record.sourceId,
          driverKey,
          role: index === 0 ? "person_in_charge" : "crew_member",
          position: index + 1,
        });
      });
      equipmentRows.forEach((row, index) => {
        const unit = rowString(row, "Trailer Number");
        const trailerKey = unit ? trailerByUnit.get(normalizeIdentity(unit)) : undefined;
        if (!trailerKey) return;
        movementTrailers.push({
          sourceKey: `${record.sourceId}:trailer:${index + 1}`,
          movementKey: record.sourceId,
          trailerKey,
          position: index + 1,
        });
      });
      sealRows.forEach((row, rowIndex) => {
        Object.entries(row).forEach(([label, value], columnIndex) => {
          if (typeof value !== "string" || !value.trim() || /^action$/i.test(label)) return;
          seals.push({
            sourceKey: `${record.sourceId}:seal:${rowIndex + 1}:${columnIndex + 1}`,
            movementKey: record.sourceId,
            trailerKey: null,
            sealNumber: value.trim(),
            sealType: label,
          });
        });
      });
      eventRows.forEach((row, index) => {
        movementEvents.push({
          sourceKey: `${record.sourceId}:event:${index + 1}`,
          movementKey: record.sourceId,
          shipmentKey: null,
          eventType: "customs_event",
          fromStatus: null,
          toStatus: null,
          payload: Object.fromEntries(Object.entries(row)),
          occurredAtLocal: rowString(row, "Event Time"),
        });
      });
      for (const [key, value] of fields.unused()) {
        exceptions.push(toException(category, record, key, value, "has no direct Corridor field"));
      }
    }
  };

  addMovements("ace_manifests", "ACE");
  addMovements("aci_trips", "ACI");

  const movementByVisibleId = new Map<string, string>();
  for (const movement of movements) {
    movementByVisibleId.set(normalizeIdentity(movement.movementNumber), movement.sourceKey);
    if (movement.tripNumber) {
      movementByVisibleId.set(normalizeIdentity(movement.tripNumber), movement.sourceKey);
      if (movement.carrierCode) {
        movementByVisibleId.set(
          normalizeIdentity(`${movement.carrierCode}${movement.tripNumber}`),
          movement.sourceKey,
        );
      }
    }
  }

  const partnerFor = (name: string | null, address: ImportAddress): string | null => {
    if (!name) return null;
    const exact = partnersByIdentity.get(partnerIdentity(name, address));
    if (exact) return exact.sourceKey;
    const byName = partners.find(
      (partner) => normalizeIdentity(partner.name) === normalizeIdentity(name),
    );
    return byName?.sourceKey ?? null;
  };

  const shipments: ShipmentImport[] = [];
  const commodities: CommodityImport[] = [];

  const addShipments = (category: "ace_shipments" | "aci_cargos", regime: "ACE" | "ACI") => {
    for (const record of categoryRecords(snapshot, category)) {
      const fields = new Fields(record);
      const carrier =
        fields.string(regime === "ACE" ? "SCAC" : "Carrier Code") ??
        (regime === "ACE" ? organization?.scacCode : organization?.canadianCarrierCode) ??
        "";
      const fullControl = fields.string(regime === "ACE" ? "SCN" : "CCC/Cargo #") ?? "";
      const detailControl = fields.string(
        regime === "ACE" ? "Shipment Control Number" : "PARS/Cargo Number",
      );
      const controlReference =
        detailControl ??
        (carrier && fullControl.toUpperCase().startsWith(carrier.toUpperCase())
          ? fullControl.slice(carrier.length)
          : fullControl);
      const attachedTrip = fields.string("Attached Trip Number", "Attached Trip", "Trip Number", "Trip #");
      const shipperAddress = addressFrom(fields, "Shipper ");
      const consigneeAddress = addressFrom(fields, "Consignee ");
      const shipperName = fields.string("Shipper Name");
      const consigneeName = fields.string("Consignee Name");
      const statusValue = fields.string("Status") ?? "";
      const commodityRows = fields.rows("Commodities");
      const eventRows = fields.rows("Event History");
      const shipment: ShipmentImport = {
        sourceKey: record.sourceId,
        regime,
        movementKey: attachedTrip
          ? movementByVisibleId.get(normalizeIdentity(attachedTrip)) ?? null
          : null,
        carrierCode: carrier,
        shipmentType: regime === "ACE" ? aceShipmentType(fields.string("Shipment Type", "Type")) : null,
        cargoType: regime === "ACI" ? aciCargoType(fields.string("Cargo Type", "Type")) : null,
        controlReference,
        isPars: regime === "ACI" && (fields.boolean("Starts With PARS") || /pars/i.test(fullControl)),
        entryNumber: fields.string("Entry #", "Entry Number"),
        entryPortCode: portCode(fields.string("Entry # Port", "Entry Port")),
        shipperKey: partnerFor(shipperName, shipperAddress),
        consigneeKey: partnerFor(consigneeName, consigneeAddress),
        destinationPortCode: portCode(fields.string("Port of Destination")),
        sublocationCode: fields.string("CBSA Sub-location"),
        loadingCountry: countryCode(fields.string("Loading Country")),
        loadingProvince: jurisdictionCode(fields.string("Loading Province/State")),
        loadingCity: fields.string("Loading City"),
        deliveryAddress: {},
        status: mapShipmentStatus(statusValue),
        notes: fields.string("Notes", "Note"),
        sourceUpdatedAt: fields.string("Last Update"),
      };
      shipments.push(shipment);
      commodityRows.forEach((row, index) => {
        const weightText = rowString(row, "Weight");
        const unit = /\blb\b/i.test(weightText ?? "") ? "LB" : "KG";
        const rawWeight = amount(weightText);
        commodities.push({
          sourceKey: `${record.sourceId}:commodity:${index + 1}`,
          shipmentKey: record.sourceId,
          lineNumber: index + 1,
          commodityDescription: rowString(row, "Description") ?? "",
          weightKg: rawWeight === null ? null : unit === "LB" ? rawWeight * 0.45359237 : rawWeight,
          weightUnit: unit,
          quantity: integer(rowString(row, "Quantity")),
          quantityUnit: null,
          marksAndNumbers: rowString(row, "Marks & Numbers"),
          isConsolidated: regime === "ACI" && fields.boolean("Consolidated Cargo"),
        });
      });
      eventRows.forEach((row, index) => {
        if (!shipment.movementKey) return;
        movementEvents.push({
          sourceKey: `${record.sourceId}:event:${index + 1}`,
          movementKey: shipment.movementKey,
          shipmentKey: record.sourceId,
          eventType: "customs_event",
          fromStatus: null,
          toStatus: null,
          payload: Object.fromEntries(Object.entries(row)),
          occurredAtLocal: rowString(row, "Event Time"),
        });
      });
      if (!shipment.carrierCode || !shipment.controlReference) {
        exceptions.push(
          toException(category, record, "Control Number", fullControl, "cannot form a Corridor control number", true),
        );
      }
      for (const [key, value] of fields.unused()) {
        exceptions.push(toException(category, record, key, value, "has no direct Corridor field"));
      }
    }
  };

  addShipments("ace_shipments", "ACE");
  addShipments("aci_cargos", "ACI");

  const externalShipments = categoryRecords(snapshot, "external_shipments").map(
    (record): ExternalShipmentImport => {
      const fields = new Fields(record);
      const status = fields.string("Status");
      return {
        sourceKey: record.sourceId,
        regime: "ACE",
        controlNumber: fields.string("ShipmentControl"),
        inBondNumber: fields.string("InBond #"),
        originatingCarrierCode: fields.string("SCAC"),
        description: null,
        status: status && /clos|export|arriv/i.test(status) ? "closed" : "open",
      };
    },
  );

  const notificationRules = users.flatMap((user) =>
    ["customs.decision", "movement.accepted", "shipment.entry_on_file"].map((eventType) => ({
      sourceKey: `${user.sourceKey}:notification:${eventType}`,
      userKey: user.sourceKey,
      eventType,
      enabled: true,
      channel: ["in_app", ...(organization?.dispatchEmails.length ? ["email"] : [])],
    })),
  );

  return {
    organization,
    carrierCodes,
    users,
    notificationRules,
    drivers,
    driverDocuments,
    trucks,
    trailers,
    equipmentPlates: [],
    partners,
    movements,
    movementCrew,
    movementTrailers,
    shipments,
    commodities,
    hazmat: [],
    seals,
    movementEvents,
    customsSubmissions: [],
    parsRnsEvents: [],
    externalShipments,
    inBondRecords: [],
    inBondEvents: [],
    exceptions,
  };
};

export { MigrationException };
