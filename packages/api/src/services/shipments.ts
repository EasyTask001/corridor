/**
 * Shipment primitives shared by the shipment router, the movement workspace
 * (`loadFull`) and document review. A shipment is the customs filing unit: it
 * exists on its own and is attached to a movement when it goes on a truck.
 */
import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  eq,
  inArray,
  schema,
  sql,
  type PgColumn,
  type RlsTransaction,
} from "@corridor/db";
import {
  addressToColumns,
  nestAddress,
  type Address,
  type CommodityInput,
  type LoadedOnValue,
  type ShipmentPatch,
} from "@corridor/domain";

const { shipments, commodities, commodityHazmat, organizationCarrierCodes, partners } = schema;

/** Build a partner's address as jsonb in SQL, for the fake DB's `sqlValues` to keep working. */
const partnerAddressJson = (partnerId: PgColumn) =>
  sql<Address | null>`(select jsonb_strip_nulls(jsonb_build_object(
      'line1', p.address_line1, 'line2', p.address_line2, 'city', p.address_city,
      'region', p.address_region, 'postalCode', p.address_postal_code, 'country', p.address_country))
    from public.partners p where p.id = ${partnerId})`;

export type Tx = RlsTransaction;

/** The two `loaded_on_*` columns as the domain's `LoadedOnValue` — the one
 * place that pairing is decoded, shared by `manifestFor` and `validationFor`. */
export function loadedOnOf(row: {
  loadedOnType: "TRUCK" | "TRAILER" | null;
  loadedOnMovementTrailerId: string | null;
}): LoadedOnValue {
  if (row.loadedOnType === "TRAILER")
    return { type: "TRAILER", movementTrailerId: row.loadedOnMovementTrailerId! };
  if (row.loadedOnType === "TRUCK") return { type: "TRUCK" };
  return null;
}

export async function requireShipment(tx: Tx, orgId: string, id: string) {
  const [s] = await tx
    .select()
    .from(shipments)
    .where(and(eq(shipments.id, id), eq(shipments.organizationId, orgId)))
    .limit(1);
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Shipment not found" });
  return s;
}

/** The org's default filing code for a regime — a shipment must carry one. */
export async function defaultCarrierCode(tx: Tx, orgId: string, regime: "ACE" | "ACI") {
  const [row] = await tx
    .select({ code: organizationCarrierCodes.code })
    .from(organizationCarrierCodes)
    .where(
      and(
        eq(organizationCarrierCodes.organizationId, orgId),
        eq(organizationCarrierCodes.regime, regime),
        eq(organizationCarrierCodes.isDefault, true),
      ),
    )
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `No default ${regime} carrier code — add one on the organization settings page.`,
    });
  }
  return row.code;
}

/** Commodity lines of the given shipments, hazmat rows folded in. */
export async function commoditiesFor(tx: Tx, shipmentIds: string[]) {
  if (shipmentIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(commodities)
    .where(inArray(commodities.shipmentId, shipmentIds))
    .orderBy(asc(commodities.lineNumber), asc(commodities.createdAt));
  const hazmat = rows.length
    ? await tx
        .select()
        .from(commodityHazmat)
        .where(
          inArray(
            commodityHazmat.commodityId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(commodityHazmat.position))
    : [];
  return rows.map((r) => ({ ...r, hazmat: hazmat.filter((h) => h.commodityId === r.id) }));
}

/** Shipments attached to a movement, with their commodities and party names. */
export async function shipmentsForMovement(tx: Tx, movementId: string) {
  const rows = await tx
    .select({
      shipment: shipments,
      shipperName: sql<
        string | null
      >`(select name from public.partners p where p.id = ${shipments.shipperId})`,
      shipperCountry: sql<
        string | null
      >`(select p.address_country from public.partners p where p.id = ${shipments.shipperId})`,
      consigneeName: sql<
        string | null
      >`(select name from public.partners p where p.id = ${shipments.consigneeId})`,
      consigneeCountry: sql<
        string | null
      >`(select p.address_country from public.partners p where p.id = ${shipments.consigneeId})`,
      brokerName: sql<
        string | null
      >`(select name from public.partners p where p.id = ${shipments.brokerId})`,
      shipperAddress: partnerAddressJson(shipments.shipperId),
      consigneeAddress: partnerAddressJson(shipments.consigneeId),
      entryPortCode: sql<
        string | null
      >`(select code from public.ports p where p.id = ${shipments.entryPortId})`,
      inBondDestinationPortCode: sql<
        string | null
      >`(select code from public.ports p where p.id = ${shipments.inBondDestinationPortId})`,
    })
    .from(shipments)
    .where(eq(shipments.movementId, movementId))
    .orderBy(asc(shipments.createdAt));
  const lines = await commoditiesFor(
    tx,
    rows.map((r) => r.shipment.id),
  );
  return rows.map(({ shipment, ...rest }) => ({
    ...nestAddress("delivery", "deliveryAddress", shipment),
    ...rest,
    commodities: lines.filter((l) => l.shipmentId === shipment.id),
  }));
}

/** Only the columns a patch may touch; `undefined` keys are left alone. */
export function shipmentSetFrom(patch: ShipmentPatch) {
  const { deliveryAddress, ...rest } = patch;
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) set[key] = value;
  }
  if (deliveryAddress !== undefined)
    Object.assign(set, addressToColumns("delivery", deliveryAddress));
  return set as Partial<typeof shipments.$inferInsert>;
}

/** Replace a commodity's hazmat rows (positions 1..3) in one go. */
export async function writeHazmat(
  tx: Tx,
  orgId: string,
  commodityId: string,
  entries: CommodityInput["hazmat"],
) {
  await tx.delete(commodityHazmat).where(eq(commodityHazmat.commodityId, commodityId));
  if (entries.length === 0) return;
  await tx.insert(commodityHazmat).values(
    entries.map((h, i) => ({
      organizationId: orgId,
      commodityId,
      position: i + 1,
      unCode: h.unCode,
      description: h.description ?? null,
      emergencyContact: h.emergencyContact ?? null,
      emergencyPhone: h.emergencyPhone ?? null,
    })),
  );
}

/** Guard the partner FKs: a restrict-FK violation is a 404, not a 500. */
export async function assertPartnersExist(tx: Tx, orgId: string, ids: Array<string | null>) {
  const wanted = ids.filter((id): id is string => !!id);
  if (wanted.length === 0) return;
  const found = await tx
    .select({ id: partners.id })
    .from(partners)
    .where(and(eq(partners.organizationId, orgId), inArray(partners.id, wanted)));
  if (found.length !== new Set(wanted).size) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Shipper or consignee not found" });
  }
}

/** Broker assignments are tenant-scoped and accept only broker/dual partners. */
export async function assertBrokerPartner(tx: Tx, orgId: string, brokerId: string | null) {
  if (!brokerId) return;
  const [partner] = await tx
    .select({ type: partners.type })
    .from(partners)
    .where(and(eq(partners.organizationId, orgId), eq(partners.id, brokerId)))
    .limit(1);
  if (!partner) throw new TRPCError({ code: "NOT_FOUND", message: "Broker not found" });
  if (partner.type !== "broker" && partner.type !== "both") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Selected partner is not a broker" });
  }
}

export async function assertShipmentPartners(
  tx: Tx,
  orgId: string,
  input: { shipperId?: string | null; consigneeId?: string | null; brokerId?: string | null },
) {
  const wanted = [input.shipperId, input.consigneeId, input.brokerId].filter(
    (id): id is string => !!id,
  );
  if (wanted.length === 0) return;
  const found = await tx
    .select({ id: partners.id, type: partners.type })
    .from(partners)
    .where(and(eq(partners.organizationId, orgId), inArray(partners.id, wanted)));
  const byId = new Map(found.map((partner) => [partner.id, partner]));
  if (wanted.some((id) => !byId.has(id))) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Shipment partner not found" });
  }
  const broker = input.brokerId ? byId.get(input.brokerId) : null;
  if (broker && broker.type !== "broker" && broker.type !== "both") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Selected partner is not a broker" });
  }
}
