/**
 * Field + column configuration for the four registries. The generic
 * RegistryPage renders forms and tables from this; validation is the
 * domain Zod schema on the server (surfaced via tRPC zodError).
 */
export type FieldType = "text" | "email" | "tel" | "date" | "number" | "select" | "textarea";

export interface FieldDef {
  name: string;
  label: string;
  type?: FieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  /** grid columns (of 2) */
  span?: 1 | 2;
  mono?: boolean;
  uppercase?: boolean;
}

export interface ColumnDef {
  key: string;
  label: string;
  /** "expiry" renders a colour-coded date chip */
  kind?: "text" | "expiry" | "status" | "mono";
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
    searchPlaceholder: "Search name, license, FAST card…",
    displayName: (r) => `${r.firstName} ${r.lastName}`,
    fields: [
      { name: "firstName", label: "First name", required: true },
      { name: "lastName", label: "Last name", required: true },
      { name: "licenseNumber", label: "License number", required: true, mono: true },
      {
        name: "licenseJurisdiction",
        label: "License province/state",
        required: true,
        placeholder: "ON",
        uppercase: true,
      },
      { name: "licenseExpiry", label: "License expiry", type: "date" },
      { name: "medicalCertExpiry", label: "Medical certificate expiry", type: "date" },
      { name: "fastCardNumber", label: "FAST card number", mono: true },
      { name: "fastCardExpiry", label: "FAST card expiry", type: "date" },
      { name: "citizenship", label: "Citizenship", placeholder: "CA", uppercase: true },
      { name: "dateOfBirth", label: "Date of birth", type: "date" },
      { name: "phone", label: "Phone", type: "tel" },
      { name: "email", label: "Email", type: "email" },
      STATUS,
      NOTES,
    ],
    columns: [
      { key: "__name", label: "Driver" },
      { key: "licenseNumber", label: "License", kind: "mono" },
      { key: "licenseExpiry", label: "License exp.", kind: "expiry" },
      { key: "fastCardExpiry", label: "FAST exp.", kind: "expiry" },
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
      { name: "registrationExpiry", label: "Registration expiry", type: "date" },
      { name: "annualInspectionExpiry", label: "Annual inspection expiry", type: "date" },
      { name: "insurancePolicyNumber", label: "Insurance policy #", mono: true },
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
      {
        name: "trailerType",
        label: "Type",
        type: "select",
        options: [
          { value: "dry_van", label: "Dry van" },
          { value: "reefer", label: "Reefer" },
          { value: "flatbed", label: "Flatbed" },
          { value: "tanker", label: "Tanker" },
          { value: "container_chassis", label: "Container chassis" },
          { value: "step_deck", label: "Step deck" },
          { value: "other", label: "Other" },
        ],
      },
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
      { name: "registrationExpiry", label: "Registration expiry", type: "date" },
      { name: "insuranceExpiry", label: "Insurance expiry", type: "date" },
      { name: "annualInspectionExpiry", label: "Annual inspection expiry", type: "date" },
      STATUS,
      NOTES,
    ],
    columns: [
      { key: "unitNumber", label: "Unit", kind: "mono" },
      { key: "trailerType", label: "Type" },
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
