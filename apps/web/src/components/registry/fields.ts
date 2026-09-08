/**
 * Field + column configuration for the four registries. The generic
 * RegistryPage renders forms and tables from this; validation is the
 * domain Zod schema on the server (surfaced via tRPC zodError).
 */
export type FieldType =
  | "text"
  | "email"
  | "tel"
  | "date"
  | "number"
  | "select"
  /** rendered as a Yes/No select, submitted as a real boolean */
  | "boolean"
  | "textarea"
  /** a small ordered list of sub-rows (extra plates), submitted as an array */
  | "repeater";

export interface FieldDef {
  name: string;
  label: string;
  type?: FieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  /** Options fetched at runtime instead of listed here. */
  optionsFrom?: "equipmentTypes";
  placeholder?: string;
  /** grid columns (of 2) */
  span?: 1 | 2;
  mono?: boolean;
  uppercase?: boolean;
  /** repeater: the sub-row fields and the row cap */
  fields?: FieldDef[];
  max?: number;
  /** repeater: label of the "add row" button */
  addLabel?: string;
}

export interface ColumnDef {
  key: string;
  label: string;
  /** "expiry" renders a colour-coded date chip; "equipmentType" a code + label */
  kind?: "text" | "expiry" | "status" | "mono" | "equipmentType";
}

export type RegistryKind = "drivers" | "trucks" | "trailers" | "partners";

const STATUS: FieldDef = {
  name: "status",
  label: "Status",
  type: "select",
  options: [
    { value: "active", label: "Active" },
    { value: "inactive", label: "Inactive" },
  ],
};
const NOTES: FieldDef = { name: "notes", label: "Notes", type: "textarea", span: 2 };
/** Extra plates beyond the primary one (equipment_plates, migration 0021). */
const EXTRA_PLATES: FieldDef = {
  name: "extraPlates",
  label: "Additional plates",
  type: "repeater",
  span: 2,
  max: 3,
  addLabel: "Add plate",
  fields: [
    { name: "plateNumber", label: "Plate", required: true, mono: true, uppercase: true },
    { name: "jurisdiction", label: "Province/state", required: true, placeholder: "MI", uppercase: true },
  ],
};

export interface RegistryConfig {
  kind: RegistryKind;
  title: string;
  singular: string;
  readPermission: string;
  writePermission: string;
  fields: FieldDef[];
  columns: ColumnDef[];
  /** compute the display name for a row */
  displayName: (row: Record<string, unknown>) => string;
  searchPlaceholder: string;
}

export const REGISTRIES: Record<RegistryKind, RegistryConfig> = {
  drivers: {
    kind: "drivers",
    title: "Drivers",
    singular: "Driver",
    readPermission: "driver.read",
    writePermission: "driver.write",
    searchPlaceholder: "Search name or license…",
    displayName: (r) => `${r.firstName} ${r.lastName}`,
    fields: [
      { name: "firstName", label: "First name", required: true },
      { name: "lastName", label: "Last name", required: true },
      {
        name: "personType",
        label: "Person type",
        type: "select",
        options: [
          { value: "driver", label: "Driver" },
          { value: "passenger", label: "Passenger" },
        ],
      },
      {
        name: "gender",
        label: "Gender",
        type: "select",
        options: [
          { value: "", label: "—" },
          { value: "M", label: "Male" },
          { value: "F", label: "Female" },
          { value: "X", label: "Unspecified" },
        ],
      },
      // Licence fields are blank for a passenger; the DB check enforces the rule.
      { name: "licenseNumber", label: "License number", mono: true },
      {
        name: "licenseJurisdiction",
        label: "License province/state",
        placeholder: "ON",
        uppercase: true,
      },
      { name: "licenseExpiry", label: "License expiry", type: "date" },
      { name: "medicalCertExpiry", label: "Medical certificate expiry", type: "date" },
      {
        name: "hazmatEndorsement",
        label: "Hazmat endorsement",
        type: "boolean",
        options: [
          { value: "false", label: "No" },
          { value: "true", label: "Yes" },
        ],
      },
      { name: "citizenship", label: "Citizenship", placeholder: "CA", uppercase: true },
      { name: "dateOfBirth", label: "Date of birth", type: "date" },
      { name: "phone", label: "Phone", type: "tel" },
      { name: "email", label: "Email", type: "email" },
      { name: "usAddress.line1", label: "US address line 1", span: 2 },
      { name: "usAddress.city", label: "US city" },
      { name: "usAddress.region", label: "US state", uppercase: true },
      { name: "usAddress.postalCode", label: "US ZIP", uppercase: true },
      { name: "usAddress.country", label: "US address country", placeholder: "US", uppercase: true },
      STATUS,
      NOTES,
    ],
    columns: [
      { key: "__name", label: "Driver" },
      { key: "personType", label: "Type" },
      { key: "licenseNumber", label: "License", kind: "mono" },
      { key: "licenseExpiry", label: "License exp.", kind: "expiry" },
      { key: "medicalCertExpiry", label: "Medical exp.", kind: "expiry" },
      { key: "status", label: "Status", kind: "status" },
    ],
  },
  trucks: {
    kind: "trucks",
    title: "Trucks",
    singular: "Truck",
    readPermission: "truck.read",
    writePermission: "truck.write",
    searchPlaceholder: "Search unit, VIN, plate…",
    displayName: (r) => `Truck ${r.unitNumber}`,
    fields: [
      { name: "unitNumber", label: "Unit number", required: true, mono: true },
      { name: "vin", label: "VIN", mono: true, uppercase: true },
      { name: "make", label: "Make" },
      { name: "model", label: "Model" },
      { name: "modelYear", label: "Year", type: "number" },
      { name: "transponderNumber", label: "Transponder #", mono: true },
      { name: "plateNumber", label: "Plate", required: true, mono: true, uppercase: true },
      {
        name: "plateJurisdiction",
        label: "Plate province/state",
        required: true,
        placeholder: "ON",
        uppercase: true,
      },
      EXTRA_PLATES,
      { name: "dotNumber", label: "US DOT number", mono: true },
      {
        name: "hazmatCapable",
        label: "Hazmat capable",
        type: "boolean",
        options: [
          { value: "false", label: "No" },
          { value: "true", label: "Yes" },
        ],
      },
      { name: "registrationExpiry", label: "Registration expiry", type: "date" },
      { name: "annualInspectionExpiry", label: "Annual inspection expiry", type: "date" },
      { name: "insuranceCompany", label: "Insurance company" },
      { name: "insurancePolicyNumber", label: "Insurance policy #", mono: true },
      { name: "insuranceAmount", label: "Insurance amount", type: "number" },
      { name: "insuranceYear", label: "Insurance year", type: "number" },
      { name: "insuranceExpiry", label: "Insurance expiry", type: "date" },
      STATUS,
      NOTES,
    ],
    columns: [
      { key: "unitNumber", label: "Unit", kind: "mono" },
      { key: "__desc", label: "Truck" },
      { key: "plateNumber", label: "Plate", kind: "mono" },
      { key: "registrationExpiry", label: "Registration", kind: "expiry" },
      { key: "insuranceExpiry", label: "Insurance", kind: "expiry" },
      { key: "annualInspectionExpiry", label: "Inspection", kind: "expiry" },
      { key: "status", label: "Status", kind: "status" },
    ],
  },
  trailers: {
    kind: "trailers",
    title: "Trailers",
    singular: "Trailer",
    readPermission: "trailer.read",
    writePermission: "trailer.write",
    searchPlaceholder: "Search unit, VIN, plate…",
    displayName: (r) => `Trailer ${r.unitNumber}`,
    fields: [
      { name: "unitNumber", label: "Unit number", required: true, mono: true },
      // CBP equipment description codes, read from public.equipment_types.
      { name: "trailerType", label: "Equipment type", type: "select", optionsFrom: "equipmentTypes" },
      { name: "vin", label: "VIN", mono: true, uppercase: true },
      { name: "lengthFt", label: "Length (ft)", type: "number" },
      { name: "plateNumber", label: "Plate", required: true, mono: true, uppercase: true },
      {
        name: "plateJurisdiction",
        label: "Plate province/state",
        required: true,
        placeholder: "ON",
        uppercase: true,
      },
      EXTRA_PLATES,
      { name: "registrationExpiry", label: "Registration expiry", type: "date" },
      { name: "insuranceExpiry", label: "Insurance expiry", type: "date" },
      { name: "annualInspectionExpiry", label: "Annual inspection expiry", type: "date" },
      STATUS,
      NOTES,
    ],
    columns: [
      { key: "unitNumber", label: "Unit", kind: "mono" },
      { key: "trailerType", label: "Type", kind: "equipmentType" },
      { key: "plateNumber", label: "Plate", kind: "mono" },
      { key: "registrationExpiry", label: "Registration", kind: "expiry" },
      { key: "insuranceExpiry", label: "Insurance", kind: "expiry" },
      { key: "annualInspectionExpiry", label: "Inspection", kind: "expiry" },
      { key: "status", label: "Status", kind: "status" },
    ],
  },
  partners: {
    kind: "partners",
    title: "Partners",
    singular: "Partner",
    readPermission: "partner.read",
    writePermission: "partner.write",
    searchPlaceholder: "Search name, contact, tax ID…",
    displayName: (r) => String(r.name),
    fields: [
      { name: "name", label: "Company name", required: true, span: 2 },
      {
        name: "type",
        label: "Role",
        type: "select",
        required: true,
        options: [
          { value: "shipper", label: "Shipper" },
          { value: "consignee", label: "Consignee" },
          { value: "broker", label: "Customs broker" },
          { value: "both", label: "Shipper & consignee" },
        ],
      },
      { name: "taxId", label: "Tax ID / BN / EIN", mono: true },
      { name: "address.line1", label: "Address line 1", span: 2 },
      { name: "address.line2", label: "Address line 2", span: 2 },
      { name: "address.city", label: "City" },
      { name: "address.region", label: "Province/state", uppercase: true },
      { name: "address.postalCode", label: "Postal / ZIP", uppercase: true },
      { name: "address.country", label: "Country", placeholder: "CA", uppercase: true },
      { name: "contactName", label: "Contact name" },
      { name: "contactEmail", label: "Contact email", type: "email" },
      { name: "contactPhone", label: "Contact phone", type: "tel" },
      STATUS,
      NOTES,
    ],
    columns: [
      { key: "name", label: "Partner" },
      { key: "type", label: "Role" },
      { key: "__city", label: "Location" },
      { key: "contactName", label: "Contact" },
      { key: "status", label: "Status", kind: "status" },
    ],
  },
};
