/**
 * Provider-neutral inputs for the printable documents. The API builds these
 * from `loadFull` + the organization; the templates never see Drizzle rows.
 */
export interface SheetCarrier {
  name: string;
  legalName: string | null;
  carrierCode: string | null;
  usDotNumber: string | null;
  filerCode: string | null;
}

export interface SheetTrip {
  regime: "ACE" | "ACI";
  movementNumber: string;
  tripNumber: string | null;
  status: string;
  portCode: string | null;
  portName: string | null;
  scheduledCrossingAt: string | null;
  customsReferenceNumber: string | null;
  isEmpty: boolean;
  iitIndicator: string;
  aciFlags: string[];
}

export interface SheetCrew {
  role: string;
  name: string;
  personType: string;
  licenseNumber: string | null;
  licenseJurisdiction: string | null;
  citizenship: string | null;
  documents: Array<{ type: string; number: string; expiresOn: string | null }>;
}

export interface SheetUnit {
  unitNumber: string;
  plates: string[];
  seals: string[];
  type?: string | null;
  vin?: string | null;
}

export interface SheetCommodity {
  line: number;
  description: string;
  hsCode: string | null;
  quantity: number | null;
  quantityUnit: string | null;
  weightKg: number | null;
  countryOfOrigin: string | null;
  hazmat: string[];
}

export interface SheetShipment {
  controlNumber: string;
  kind: string | null;
  entryNumber: string | null;
  entryPortCode: string | null;
  status: string;
  shipper: string | null;
  consignee: string | null;
  inBond: string | null;
  commodities: SheetCommodity[];
}

export interface SheetCustomsEvent {
  label: string;
  occurredAt: string;
  detail: string | null;
}

export interface DriverSheetData {
  carrier: SheetCarrier;
  trip: SheetTrip;
  crew: SheetCrew[];
  truck: SheetUnit | null;
  trailers: SheetUnit[];
  shipments: SheetShipment[];
  /** Latest gateway messages, newest last (manifest summary only). */
  customsEvents: SheetCustomsEvent[];
  generatedAt: string;
  /** Avaal's "simple" sheet: no commodity lines. */
  simple: boolean;
}

export interface BlankSheetData {
  carrier: SheetCarrier;
  regime: "ACE" | "ACI";
  /** One page per trip number in the range. */
  tripNumbers: string[];
  driverName: string | null;
  coDriverName: string | null;
  generatedAt: string;
}

export interface TableReportData {
  title: string;
  subtitle: string | null;
  carrier: SheetCarrier;
  columns: Array<{ key: string; label: string; width?: number }>;
  rows: Array<Record<string, string | number | null>>;
  generatedAt: string;
}
