import { z } from "zod";
import { uuid } from "./common";
import { countryCode, currency, hsCode, regime } from "./movement";
import {
  controlReference,
  aceShipmentType,
  aciCargoType,
  inBondEntryType,
  quantityUnit,
  weightUnit,
} from "./shipment";

// ---------------------------------------------------------------------------
// CSV bulk import (0028) — templates, row schemas, report
// ---------------------------------------------------------------------------

export const importKind = z.enum(["shipments", "commodities"]);
export type ImportKind = z.infer<typeof importKind>;

export interface ImportColumn {
  key: string;
  label: string;
  required?: boolean;
  example: string;
  note?: string;
}

/**
 * The column specs behind `docs/import-templates/*.csv` and the wizard's
 * column reference. Headers are matched case-insensitively with spaces and
 * dashes folded to underscores, so "Control Reference" and "control_reference"
 * are the same column.
 */
export const IMPORT_TEMPLATES: Record<ImportKind, ImportColumn[]> = {
  shipments: [
    { key: "regime", label: "Regime", required: true, example: "ACE", note: "ACE or ACI" },
    {
      key: "carrier_code",
      label: "Carrier code",
      example: "PFTR",
      note: "blank = the regime's default code",
    },
    {
      key: "control_reference",
      label: "Control reference",
      required: true,
      example: "PAPS90101",
      note: "PAPS / PARS / bill part; the carrier code is prefixed",
    },
    {
      key: "shipment_type",
      label: "Shipment type (ACE)",
      example: "regular_bill",
      note: "regular_bill, section_321, goods_astray, free_of_duty_7523, free_return_us_goods_3311, unaccounted_articles_3299, in_bond",
    },
    {
      key: "cargo_type",
      label: "Cargo type (ACI)",
      example: "regular",
      note: "regular, consolidated, csa, a49, e29b",
    },
    {
      key: "shipper_name",
      label: "Shipper",
      example: "Maple Ridge Steel Ltd",
      note: "must match a partner name",
    },
    {
      key: "consignee_name",
      label: "Consignee",
      example: "Great Lakes Fabrication Inc",
      note: "must match a partner name",
    },
    {
      key: "broker_name",
      label: "Broker",
      example: "Northgate Customs Brokers",
      note: "must match a broker or dual-role partner name",
    },
    { key: "entry_port", label: "Entry port", example: "3801", note: "CBP port code" },
    { key: "in_bond_entry_type", label: "In-bond entry type", example: "", note: "IT, TE or IE" },
    {
      key: "in_bond_destination",
      label: "In-bond destination",
      example: "",
      note: "CBP in-bond destination code",
    },
    { key: "is_pars", label: "PARS", example: "false", note: "true/false" },
    {
      key: "destination_port",
      label: "Destination office (ACI)",
      example: "",
      note: "CBSA office code",
    },
    {
      key: "sublocation",
      label: "Sub-location (ACI)",
      example: "",
      note: "CBSA sub-location code",
    },
    { key: "loading_country", label: "Loading country (ACI)", example: "", note: "2-letter" },
    { key: "loading_province", label: "Loading province (ACI)", example: "" },
    { key: "loading_city", label: "Loading city (ACI)", example: "" },
    { key: "consignee_business_number", label: "Consignee business # (ACI)", example: "" },
  ],
  commodities: [
    {
      key: "control_number",
      label: "Control number",
      required: true,
      example: "PFTRPAPS90101",
      note: "an existing shipment's full control number",
    },
    { key: "line_number", label: "Line #", example: "1", note: "blank = next line" },
    { key: "description", label: "Description", required: true, example: "Hot-rolled steel coils" },
    { key: "hs_code", label: "HS code", example: "7208.39" },
    { key: "quantity", label: "Quantity", example: "6" },
    {
      key: "quantity_unit",
      label: "Quantity unit",
      example: "Coil",
      note: "Bag, Bale, Barrel, Box, Bundle, Carton, Case, Coil, Crate, Drum, Pallet, Piece, Roll, …",
    },
    { key: "weight", label: "Weight", example: "18000" },
    { key: "weight_unit", label: "Weight unit", example: "KG", note: "KG or LB" },
    { key: "country_of_origin", label: "Country of origin", example: "CA" },
    { key: "marks_and_numbers", label: "Marks and numbers", example: "" },
    { key: "hazmat_code_1", label: "Hazmat UN code 1", example: "", note: "UN1203" },
    { key: "hazmat_description_1", label: "Hazmat description 1", example: "" },
    { key: "hazmat_contact_1", label: "Hazmat contact 1", example: "" },
    { key: "hazmat_phone_1", label: "Hazmat phone 1", example: "" },
    { key: "hazmat_code_2", label: "Hazmat UN code 2", example: "" },
    { key: "hazmat_description_2", label: "Hazmat description 2", example: "" },
    { key: "hazmat_contact_2", label: "Hazmat contact 2", example: "" },
    { key: "hazmat_phone_2", label: "Hazmat phone 2", example: "" },
    { key: "hazmat_code_3", label: "Hazmat UN code 3", example: "" },
    { key: "hazmat_description_3", label: "Hazmat description 3", example: "" },
    { key: "hazmat_contact_3", label: "Hazmat contact 3", example: "" },
    { key: "hazmat_phone_3", label: "Hazmat phone 3", example: "" },
    { key: "value_amount", label: "Value", example: "42000" },
    { key: "value_currency", label: "Currency", example: "USD", note: "USD or CAD" },
    { key: "is_consolidated", label: "Consolidated", example: "false", note: "true/false" },
  ],
};

/** The header line of a template. */
export const importTemplateHeader = (kind: ImportKind) =>
  IMPORT_TEMPLATES[kind].map((c) => c.key).join(",");

const blank = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" ? undefined : v));
const bool = z
  .string()
  .trim()
  .toLowerCase()
  .optional()
  .transform((v) => (v === undefined || v === "" ? false : ["true", "yes", "y", "1"].includes(v)));
const num = (label: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return undefined;
      const n = Number(v.replace(/,/g, ""));
      if (!Number.isFinite(n))
        ctx.addIssue({ code: "custom", message: `${label} must be a number` });
      return n;
    });
const upper = z
  .string()
  .trim()
  .toUpperCase()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

/** One CSV row of the shipments template, as typed (names, codes) — not yet resolved. */
export const shipmentImportRow = z
  .object({
    regime: z.string().trim().toUpperCase().pipe(regime),
    carrier_code: upper,
    control_reference: z.string().trim().toUpperCase().pipe(controlReference),
    shipment_type: z
      .string()
      .trim()
      .toLowerCase()
      .optional()
      .transform((v) => (v === "" ? undefined : v)),
    cargo_type: z
      .string()
      .trim()
      .toLowerCase()
      .optional()
      .transform((v) => (v === "" ? undefined : v)),
    shipper_name: blank,
    consignee_name: blank,
    broker_name: blank,
    entry_port: upper,
    in_bond_entry_type: upper.pipe(inBondEntryType.optional()),
    in_bond_destination: upper,
    is_pars: bool,
    destination_port: upper,
    sublocation: upper,
    loading_country: upper.pipe(countryCode.optional()),
    loading_province: blank,
    loading_city: blank,
    consignee_business_number: blank,
  })
  .superRefine((r, ctx) => {
    if (r.regime === "ACE") {
      if (!r.shipment_type || !aceShipmentType.safeParse(r.shipment_type).success)
        ctx.addIssue({
          code: "custom",
          path: ["shipment_type"],
          message: "ACE needs a valid shipment_type",
        });
      if (r.cargo_type)
        ctx.addIssue({ code: "custom", path: ["cargo_type"], message: "cargo_type is ACI only" });
    } else {
      if (!r.cargo_type || !aciCargoType.safeParse(r.cargo_type).success)
        ctx.addIssue({
          code: "custom",
          path: ["cargo_type"],
          message: "ACI needs a valid cargo_type",
        });
      if (r.shipment_type)
        ctx.addIssue({
          code: "custom",
          path: ["shipment_type"],
          message: "shipment_type is ACE only",
        });
    }
    if (r.shipment_type === "in_bond" && !r.in_bond_entry_type)
      ctx.addIssue({
        code: "custom",
        path: ["in_bond_entry_type"],
        message: "an in-bond shipment needs IT, TE or IE",
      });
  });
export type ShipmentImportRow = z.infer<typeof shipmentImportRow>;

const hazmatCode = upper.pipe(
  z
    .string()
    .regex(/^UN\d{4}$/, "UN code must look like UN1203")
    .optional(),
);

/** One CSV row of the commodities template. */
export const commodityImportRow = z.object({
  control_number: z.string().trim().toUpperCase().min(6).max(24),
  line_number: num("line_number").pipe(z.number().int().positive().optional()),
  description: z.string().trim().min(1, "description is required").max(500),
  hs_code: blank.pipe(hsCode.optional()),
  quantity: num("quantity").pipe(z.number().int().positive().optional()),
  quantity_unit: blank.pipe(quantityUnit.optional()),
  weight: num("weight").pipe(z.number().positive().max(1_000_000).optional()),
  weight_unit: upper.pipe(weightUnit.optional()),
  country_of_origin: upper.pipe(countryCode.optional()),
  marks_and_numbers: blank,
  hazmat_code_1: hazmatCode,
  hazmat_description_1: blank,
  hazmat_contact_1: blank,
  hazmat_phone_1: blank,
  hazmat_code_2: hazmatCode,
  hazmat_description_2: blank,
  hazmat_contact_2: blank,
  hazmat_phone_2: blank,
  hazmat_code_3: hazmatCode,
  hazmat_description_3: blank,
  hazmat_contact_3: blank,
  hazmat_phone_3: blank,
  value_amount: num("value_amount").pipe(z.number().nonnegative().optional()),
  value_currency: upper.pipe(currency.optional()),
  is_consolidated: bool,
});
export type CommodityImportRow = z.infer<typeof commodityImportRow>;

export interface ImportRowError {
  column: string;
  message: string;
}
export interface ImportReportRow {
  /** 1-based data line (header is line 1, so the first data row is 2). */
  line: number;
  status: "ok" | "error";
  errors: ImportRowError[];
  /** A short label for the wizard table (control number, description). */
  label: string;
}
export interface ImportReport {
  rows: ImportReportRow[];
  okCount: number;
  errorCount: number;
}

export const importValidateInput = z.object({
  kind: importKind,
  filename: z.string().trim().min(1).max(200),
  /** The whole file, read client-side. ~2 MB covers a few thousand rows. */
  content: z.string().max(2_000_000),
});
export type ImportValidateInput = z.infer<typeof importValidateInput>;

export const importBatchInput = z.object({ batchId: uuid });
export const importTemplateInput = z.object({ kind: importKind });
export const importListInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});
