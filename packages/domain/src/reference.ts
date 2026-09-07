import { z } from "zod";
import { uuid } from "./common";
import { carrierCode, regime } from "./movement";

/** Matches public.ports.kind (migration 0018). */
export const portKind = z.enum([
  "port_of_entry",
  "in_bond_destination",
  "cbsa_office",
  "firms",
  "sublocation",
]);
export type PortKind = z.infer<typeof portKind>;

export const portCountry = z.enum(["US", "CA"]);

export const portSchema = z.object({
  id: uuid,
  regime,
  kind: portKind,
  code: z.string(),
  name: z.string(),
  stateProvince: z.string().nullable(),
  country: portCountry,
  parentCode: z.string().nullable(),
  active: z.boolean(),
});
export type Port = z.infer<typeof portSchema>;

export const portsSearchInput = z.object({
  regime: regime.optional(),
  kind: portKind.optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type PortsSearchInput = z.infer<typeof portsSearchInput>;

export const carrierCodeInput = z.object({
  regime,
  code: carrierCode,
  label: z.string().trim().max(120).optional(),
  isDefault: z.boolean().optional(),
});
export type CarrierCodeInput = z.infer<typeof carrierCodeInput>;

export const carrierCodeUpsertInput = carrierCodeInput.extend({ id: uuid.optional() });
export type CarrierCodeUpsertInput = z.infer<typeof carrierCodeUpsertInput>;

export const carrierCodeRemoveInput = z.object({ id: uuid });
export const carrierCodeSetDefaultInput = z.object({ id: uuid });
