/**
 * Per-record history (Task 13): which read permission unlocks the audit rows
 * of each entity type. Keys are the `entity_type` values `writeAudit` writes.
 */
import { z } from "zod";
import type { PermissionKey } from "@corridor/domain";

export const HISTORY_ENTITY_PERMISSIONS = {
  movement: "movement.read",
  shipment: "shipment.read",
  driver: "driver.read",
  truck: "truck.read",
  trailer: "trailer.read",
  partner: "partner.read",
  in_bond_record: "inbond.read",
  external_shipment: "inbond.read",
  import_batch: "shipment.read",
  generated_document: "movement.read",
} as const satisfies Record<string, PermissionKey>;

export type HistoryEntityType = keyof typeof HISTORY_ENTITY_PERMISSIONS;
export const historyEntityType = z.enum(
  Object.keys(HISTORY_ENTITY_PERMISSIONS) as [HistoryEntityType, ...HistoryEntityType[]],
);
