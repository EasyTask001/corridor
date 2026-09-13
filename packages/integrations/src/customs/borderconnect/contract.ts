export type BorderConnectDocument =
  "ACE_TRIP" | "ACI_TRIP" | "ACE_SEND_REQUEST" | "ACI_SEND_REQUEST";

type JsonType = "string" | "number" | "boolean" | "object" | "array";
type Definition = readonly [
  path: string,
  type: JsonType,
  required: boolean,
  minLength?: number,
  maxLength?: number,
  pattern?: string,
];

export interface BorderConnectContractField {
  document: BorderConnectDocument;
  externalPath: string;
  required: boolean;
  type: JsonType;
  minLength: number | null;
  maxLength: number | null;
  pattern: string | null;
  mapperSource: string;
  manualVersion: string;
}

function fields(
  document: BorderConnectDocument,
  root: string,
  manualVersion: string,
  mapperSource: string,
  definitions: readonly Definition[],
): BorderConnectContractField[] {
  return definitions.map(([path, type, required, minLength, maxLength, pattern]) => ({
    document,
    externalPath: root + "." + path,
    required,
    type,
    minLength: minLength ?? null,
    maxLength: maxLength ?? null,
    pattern: pattern ?? null,
    mapperSource,
    manualVersion,
  }));
}

const DATE_TIME = "^[2-9][0-9]{3}-[0-1][0-9]-[0-3][0-9]\\s[0-2][0-9]:[0-5][0-9]:[0-5][0-9]$";

const ACE_TRIP = fields("ACE_TRIP", "aceTrip", "1.0.7", "ace.ts", [
  ["data", "string", true, 8, 20, "^ACE_TRIP$"],
  ["sendId", "string", false, 1, 68],
  ["companyKey", "string", false, 1, 30],
  ["operation", "string", false, 1, 10],
  ["autoSend", "boolean", false],
  ["tripNumber", "string", true, 8, 25],
  ["estimatedArrivalDateTime", "string", true, 19, 19, DATE_TIME],
  ["usPortOfArrival", "string", true, 4, 4, "^[0-9]{4}$"],
  ["instrumentsOfInternationalTrafficBond", "object", false],
  ["instrumentsOfInternationalTrafficBond.type", "string", true],
  ["truck", "object", true],
  ["truck.number", "string", true, 1, 17],
  ["truck.type", "string", true, 2, 2],
  ["truck.vinNumber", "string", true, 17, 17],
  ["truck.licensePlates", "array", true],
  ["truck.licensePlates[].number", "string", true, 1, 10],
  ["truck.licensePlates[].stateProvince", "string", true, 2, 3],
  ["truck.sealNumbers", "array", false],
  ["truck.sealNumbers[]", "string", true, 1, 15],
  ["truck.dotNumber", "string", false, 1, 8],
  ["trailers", "array", false],
  ["trailers[].number", "string", true, 1, 17],
  ["trailers[].type", "string", true, 2, 2],
  ["trailers[].licensePlates", "array", true],
  ["trailers[].licensePlates[].number", "string", true, 1, 10],
  ["trailers[].licensePlates[].stateProvince", "string", true, 2, 3],
  ["trailers[].sealNumbers", "array", false],
  ["trailers[].sealNumbers[]", "string", true, 1, 15],
  ["drivers", "array", true],
  ["drivers[].firstName", "string", true, 1, 30],
  ["drivers[].lastName", "string", true, 1, 30],
  ["drivers[].gender", "string", false, 1, 1, "^[MF]$"],
  ["drivers[].dateOfBirth", "string", false, 10, 10],
  ["drivers[].citizenshipCountry", "string", false, 2, 2],
  ["drivers[].fastCardNumber", "string", false, 14, 14],
  ["drivers[].travelDocuments", "array", false],
  ["drivers[].travelDocuments[].type", "string", true, 2, 3],
  ["drivers[].travelDocuments[].number", "string", true, 1, 30],
  ["drivers[].travelDocuments[].country", "string", false, 2, 2],
  ["drivers[].travelDocuments[].stateProvince", "string", false, 2, 3],
  ["passengers", "array", false],
  ["passengers[].firstName", "string", true, 1, 30],
  ["passengers[].lastName", "string", true, 1, 30],
  ["passengers[].gender", "string", true, 1, 1, "^[MF]$"],
  ["passengers[].dateOfBirth", "string", true, 10, 10],
  ["passengers[].citizenshipCountry", "string", true, 2, 2],
  ["passengers[].travelDocuments", "array", true],
  ["passengers[].travelDocuments[].type", "string", true, 2, 3],
  ["passengers[].travelDocuments[].number", "string", true, 1, 30],
  ["passengers[].travelDocuments[].country", "string", false, 2, 2],
  ["passengers[].travelDocuments[].stateProvince", "string", false, 2, 3],
  ["shipments", "array", false],
  ["shipments[].data", "string", false, 8, 20, "^ACE_SHIPMENT$"],
  ["shipments[].companyKey", "string", false, 1, 30],
  ["shipments[].shipmentControlNumber", "string", true, 8, 16, "^[A-Z]{4}[A-Z0-9]{4,12}$"],
  ["shipments[].type", "string", true, 4, 15],
  ["shipments[].provinceOfLoading", "string", true, 2, 5, "^[A-Z0-9]{2,5}$"],
  ["shipments[].shipper", "object", true],
  ["shipments[].shipper.name", "string", true, 1, 60],
  ["shipments[].shipper.address", "object", true],
  ["shipments[].shipper.address.addressLine", "string", true, 1, 110],
  ["shipments[].shipper.address.city", "string", true, 2, 30],
  ["shipments[].shipper.address.postalCode", "string", true, 1, 10],
  ["shipments[].shipper.address.stateProvince", "string", false, 2, 3],
  ["shipments[].shipper.address.country", "string", false, 2, 2],
  ["shipments[].consignee", "object", true],
  ["shipments[].consignee.name", "string", true, 1, 60],
  ["shipments[].consignee.address", "object", true],
  ["shipments[].consignee.address.addressLine", "string", true, 1, 110],
  ["shipments[].consignee.address.city", "string", true, 2, 30],
  ["shipments[].consignee.address.postalCode", "string", true, 1, 10],
  ["shipments[].consignee.address.stateProvince", "string", false, 2, 3],
  ["shipments[].consignee.address.country", "string", false, 2, 2],
  ["shipments[].commodities", "array", true],
  ["shipments[].commodities[].description", "string", true, 1, 512],
  ["shipments[].commodities[].quantity", "number", true],
  ["shipments[].commodities[].packagingUnit", "string", true, 3, 3, "^[A-Z]{3}$"],
  ["shipments[].commodities[].weight", "number", true],
  ["shipments[].commodities[].weightUnit", "string", true, 1, 3, "^[LK][BG]?[SRM]?$"],
  ["shipments[].commodities[].marksAndNumbers", "array", false],
  ["shipments[].commodities[].marksAndNumbers[]", "string", true, 1, 45],
  ["shipments[].commodities[].harmonizedCode", "string", false, 6, 10, "^[0-9]{6,10}$"],
  ["shipments[].commodities[].value", "string", false, 1, 9, "^[0-9.]{1,9}$"],
  ["shipments[].commodities[].countryOfOrigin", "string", false, 2, 2, "^[A-Z]{2}$"],
] as const);

const ACI_TRIP = fields("ACI_TRIP", "aciTrip", "1.0.6", "aci.ts", [
  ["data", "string", true, 8, 20, "^ACI_TRIP$"],
  ["sendId", "string", false, 1, 68],
  ["companyKey", "string", false, 1, 30],
  ["operation", "string", false, 1, 10],
  ["autoSend", "boolean", false],
  ["tripNumber", "string", true, 8, 25],
  ["estimatedArrivalDateTime", "string", true, 19, 19, DATE_TIME],
  ["portOfEntry", "string", true, 4, 4, "^[0-9]{4}$"],
  ["truck", "object", true],
  ["truck.number", "string", true, 1, 17],
  ["truck.licensePlate", "object", true],
  ["truck.licensePlate.number", "string", true, 1, 10],
  ["truck.licensePlate.stateProvince", "string", true, 2, 3],
  ["truck.type", "string", false, 2, 2],
  ["truck.vinNumber", "string", false, 17, 17],
  ["truck.sealNumbers", "array", false],
  ["truck.sealNumbers[]", "string", true, 1, 15],
  ["truck.dotNumber", "string", false, 1, 8],
  ["trailers", "array", false],
  ["trailers[].number", "string", true, 1, 17],
  ["trailers[].type", "string", true, 2, 2],
  ["trailers[].licensePlate", "object", true],
  ["trailers[].licensePlate.number", "string", true, 1, 10],
  ["trailers[].licensePlate.stateProvince", "string", true, 2, 3],
  ["trailers[].sealNumbers", "array", false],
  ["trailers[].sealNumbers[]", "string", true, 1, 15],
  ["drivers", "array", false],
  ["drivers[].firstName", "string", true, 1, 30],
  ["drivers[].lastName", "string", true, 1, 30],
  ["drivers[].gender", "string", false, 1, 1, "^[MF]$"],
  ["drivers[].dateOfBirth", "string", false, 10, 10],
  ["drivers[].citizenshipCountry", "string", false, 2, 2],
  ["drivers[].fastCardNumber", "string", false, 14, 14],
  ["drivers[].travelDocuments", "array", false],
  ["drivers[].travelDocuments[].type", "string", true, 2, 3],
  ["drivers[].travelDocuments[].number", "string", true, 1, 30],
  ["drivers[].travelDocuments[].country", "string", false, 2, 2],
  ["drivers[].travelDocuments[].stateProvince", "string", false, 2, 3],
  ["shipments", "array", false],
  ["shipments[].data", "string", false, 8, 20, "^ACI_SHIPMENT$"],
  ["shipments[].companyKey", "string", false, 1, 30],
  ["shipments[].cargoControlNumber", "string", true, 8, 25, "^[A-Z0-9-]{8,25}$"],
  ["shipments[].shipmentType", "string", true, 3, 4],
  ["shipments[].consolidatedFreight", "boolean", false],
  ["shipments[].portOfEntry", "string", true, 4, 4, "^[0-9]{4}$"],
  ["shipments[].releaseOffice", "string", true, 4, 4, "^[0-9]{4}$"],
  ["shipments[].estimatedArrivalDate", "string", true, 19, 19, DATE_TIME],
  ["shipments[].cityOfLoading", "object", true],
  ["shipments[].cityOfLoading.cityName", "string", true, 1, 25],
  ["shipments[].cityOfLoading.stateProvince", "string", true, 2, 3],
  ["shipments[].shipper", "object", true],
  ["shipments[].shipper.name", "string", true, 1, 60],
  ["shipments[].shipper.address", "object", true],
  ["shipments[].shipper.address.addressLine", "string", true, 1, 110],
  ["shipments[].shipper.address.city", "string", true, 1, 30],
  ["shipments[].shipper.address.postalCode", "string", true, 1, 10],
  ["shipments[].shipper.address.stateProvince", "string", false, 2, 3],
  ["shipments[].shipper.address.country", "string", false, 2, 2],
  ["shipments[].consignee", "object", true],
  ["shipments[].consignee.name", "string", true, 1, 60],
  ["shipments[].consignee.address", "object", true],
  ["shipments[].consignee.address.addressLine", "string", true, 1, 110],
  ["shipments[].consignee.address.city", "string", true, 1, 30],
  ["shipments[].consignee.address.postalCode", "string", true, 1, 10],
  ["shipments[].consignee.address.stateProvince", "string", false, 2, 3],
  ["shipments[].consignee.address.country", "string", false, 2, 2],
  ["shipments[].deliveryDestinations", "array", false],
  ["shipments[].deliveryDestinations[].name", "string", true, 1, 60],
  ["shipments[].deliveryDestinations[].address", "object", true],
  ["shipments[].deliveryDestinations[].address.addressLine", "string", true, 1, 110],
  ["shipments[].deliveryDestinations[].address.city", "string", true, 1, 30],
  ["shipments[].deliveryDestinations[].address.postalCode", "string", true, 1, 10],
  ["shipments[].deliveryDestinations[].address.stateProvince", "string", false, 2, 3],
  ["shipments[].deliveryDestinations[].address.country", "string", false, 2, 2],
  ["shipments[].commodities", "array", true],
  ["shipments[].commodities[].description", "string", true, 1, 450],
  ["shipments[].commodities[].quantity", "number", true],
  ["shipments[].commodities[].packagingUnit", "string", true, 3, 3, "^[A-Z]{3}$"],
  ["shipments[].commodities[].weight", "string", true, 1],
  ["shipments[].commodities[].weightUnit", "string", true, 1, 3],
  ["shipments[].commodities[].marksAndNumbers", "string", false, 1, 35],
] as const);

const ACE_SEND_REQUEST = fields("ACE_SEND_REQUEST", "aceSendRequest", "1.0.2", "send-request.ts", [
  ["data", "string", true, 8, 20, "^ACE_SEND_REQUEST$"],
  ["sendId", "string", false, 1, 68],
  ["companyKey", "string", false, 1, 30],
  ["type", "string", true, 1, 40],
  ["tripNumber", "string", false, 8, 25],
] as const);

const ACI_SEND_REQUEST = fields("ACI_SEND_REQUEST", "aciSendRequest", "1.0.2", "send-request.ts", [
  ["data", "string", true, 8, 20, "^ACI_SEND_REQUEST$"],
  ["sendId", "string", false, 1, 68],
  ["companyKey", "string", false, 1, 30],
  ["type", "string", true, 1, 8],
  ["tripNumber", "string", false, 8, 25],
  ["cargoControlNumber", "string", false, 8, 25],
  ["bundleTripAndShipments", "boolean", true],
  ["tripAmendmentReasonCode", "string", false, 2, 2, "^[0-9]{2}$"],
  ["shipmentAmendmentReasonCode", "string", false, 2, 2, "^[0-9]{2}$"],
] as const);

export const BORDERCONNECT_CONTRACT_MATRIX: readonly BorderConnectContractField[] = [
  ...ACE_TRIP,
  ...ACI_TRIP,
  ...ACE_SEND_REQUEST,
  ...ACI_SEND_REQUEST,
];

const ROOTS: Record<BorderConnectDocument, string> = {
  ACE_TRIP: "aceTrip",
  ACI_TRIP: "aciTrip",
  ACE_SEND_REQUEST: "aceSendRequest",
  ACI_SEND_REQUEST: "aciSendRequest",
};

const MANUALS: Record<BorderConnectDocument, string> = {
  ACE_TRIP: "ACE eManifest manual 1.0.7",
  ACI_TRIP: "ACI eManifest manual 1.0.6",
  ACE_SEND_REQUEST: "ACE Send Request manual 1.0.2",
  ACI_SEND_REQUEST: "ACI Send Request manual 1.0.2",
};

function emittedPaths(value: unknown, path: string, result: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === "object") emittedPaths(item, path + "[]", result);
      else result.push(path + "[]");
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path + "." + key;
    result.push(childPath);
    emittedPaths(child, childPath, result);
  }
}

function valuesAt(value: unknown, segments: string[], index = 0): unknown[] {
  if (index >= segments.length) return [value];
  if (value === null || typeof value !== "object") return [];
  const segment = segments[index]!;
  const array = segment.endsWith("[]");
  const key = array ? segment.slice(0, -2) : segment;
  const child = (value as Record<string, unknown>)[key];
  if (array) {
    if (!Array.isArray(child)) return child === undefined ? [] : [child];
    return child.flatMap((item) => valuesAt(item, segments, index + 1));
  }
  if (index === segments.length - 1) return [child];
  return child === undefined ? [] : valuesAt(child, segments, index + 1);
}

function matchesType(value: unknown, type: JsonType): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

export function validateBorderConnectContract(
  document: BorderConnectDocument,
  payload: Record<string, unknown>,
): string[] {
  const root = ROOTS[document];
  const matrix = BORDERCONNECT_CONTRACT_MATRIX.filter((field) => field.document === document);
  const byPath = new Set(matrix.map((field) => field.externalPath));
  const emitted: string[] = [];
  emittedPaths(payload, root, emitted);
  const problems = Array.from(new Set(emitted))
    .filter((path) => !byPath.has(path))
    .map((path) => path + ": field is not in " + MANUALS[document]);

  for (const field of matrix) {
    const relative = field.externalPath.slice(root.length + 1).split(".");
    const values = valuesAt(payload, relative);
    if (
      field.required &&
      values.some(
        (value) =>
          value === undefined ||
          value === null ||
          (field.type === "array" && Array.isArray(value) && value.length === 0),
      )
    ) {
      problems.push(field.externalPath + ": required");
      continue;
    }
    for (const value of values) {
      if (value === undefined) continue;
      // Optional nullable Corridor fields are intentionally emitted as null
      // by the mappers; required fields were rejected above, so a null here
      // means the optional wire field is omitted rather than mistyped.
      if (value === null && !field.required) continue;
      if (value === null || !matchesType(value, field.type)) {
        problems.push(field.externalPath + ": must be " + field.type);
        continue;
      }
      if (typeof value !== "string") continue;
      if (field.minLength !== null && value.length < field.minLength) {
        problems.push(field.externalPath + ": must be at least " + field.minLength + " characters");
      }
      if (field.maxLength !== null && value.length > field.maxLength) {
        problems.push(field.externalPath + ": must be at most " + field.maxLength + " characters");
      }
      if (field.pattern !== null && !new RegExp(field.pattern).test(value)) {
        problems.push(field.externalPath + ": must match " + field.pattern);
      }
    }
  }
  return problems;
}
