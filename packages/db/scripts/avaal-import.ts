import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { createDb, schema } from "../src/client";
import { mapAvaalSnapshot } from "../src/avaal-import/mapping";

const snapshotPath = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const execute = process.argv.includes("--execute");
if (!snapshotPath) throw new Error("usage: avaal:import <snapshot.json> [--execute]");
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const bundle = mapAvaalSnapshot(snapshot);
const dateOrNull = (value: string | null): Date | null => { if (!value) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; };
if (!bundle.organization) throw new Error("Avaal company record is missing");
if (!execute) {
  console.log(JSON.stringify({ dryRun: true, organization: bundle.organization.name, drivers: bundle.drivers.length, trucks: bundle.trucks.length, trailers: bundle.trailers.length, partners: bundle.partners.length, movements: bundle.movements.length, shipments: bundle.shipments.length, commodities: bundle.commodities.length, blocking: bundle.exceptions.filter((e) => e.blocking).length }, null, 2));
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for --execute");
const { db, sql: client } = createDb(url, { max: 1 });

await db.transaction(async (tx) => {
  const candidates = await tx.select({ id: schema.organizations.id, name: schema.organizations.name }).from(schema.organizations);
  const target = candidates.find((row) => row.name.toLowerCase().replace(/[^a-z0-9]/g, "") === "pathfindertransinc");
  if (!target) throw new Error("Pathfinder test organization not found; refusing replacement");
  await tx.delete(schema.organizations).where(eq(schema.organizations.id, target.id));
  await tx.insert(schema.organizations).values({ id: target.id, ...bundle.organization!, billingAddress: bundle.organization!.billingAddress });

  if (bundle.carrierCodes.length) await tx.insert(schema.organizationCarrierCodes).values(bundle.carrierCodes.map((x) => ({ organizationId: target.id, regime: x.regime, code: x.code, isDefault: x.isDefault })));
  const driverIds = new Map<string, string>();
  for (const x of bundle.drivers) { const id = crypto.randomUUID(); driverIds.set(x.sourceKey, id); await tx.insert(schema.drivers).values({ id, organizationId: target.id, firstName: x.firstName, lastName: x.lastName, licenseNumber: x.licenseNumber, licenseJurisdiction: x.licenseJurisdiction, dateOfBirth: x.dateOfBirth, citizenship: x.citizenship, phone: x.phone, email: x.email, gender: x.gender, hazmatEndorsement: x.hazmatEndorsement, usAddress: x.address, smsOptIn: x.smsOptIn, smsPhoneAce: x.smsPhoneAce, smsPhoneAci: x.smsPhoneAci, status: x.status }); }
  const truckIds = new Map<string, string>();
  for (const x of bundle.trucks) { const id = crypto.randomUUID(); truckIds.set(x.sourceKey, id); await tx.insert(schema.trucks).values({ id, organizationId: target.id, unitNumber: x.unitNumber, vin: x.vin, plateNumber: x.plateNumber, plateJurisdiction: x.plateJurisdiction, transponderNumber: x.transponderNumber, dotNumber: x.dotNumber, hazmatCapable: x.hazmatCapable, insuranceCompany: x.insuranceCompany, insurancePolicyNumber: x.insurancePolicyNumber, insuranceAmount: x.insuranceAmount, insuranceYear: x.insuranceYear, status: x.status }); }
  const trailerIds = new Map<string, string>();
  for (const x of bundle.trailers) { const id = crypto.randomUUID(); trailerIds.set(x.sourceKey, id); await tx.insert(schema.trailers).values({ id, organizationId: target.id, unitNumber: x.unitNumber, trailerType: "TF", plateNumber: x.plateNumber, plateJurisdiction: x.plateJurisdiction, status: x.status }); }
  const partnerIds = new Map<string, string>();
  for (const x of bundle.partners) { if (!x.name.trim()) continue; const id = crypto.randomUUID(); for (const key of x.sourceKeys) partnerIds.set(key, id); await tx.insert(schema.partners).values({ id, organizationId: target.id, name: x.name, type: x.type, address: x.address, contactName: x.contactName, contactEmail: x.contactEmail, contactPhone: x.contactPhone, status: x.status }); }
  const movementIds = new Map<string, string>();
  const usedMovementNumbers = new Set<string>();
  const movementStatuses = new Map<string, typeof bundle.movements[number]["status"]>();
  for (const x of bundle.movements) { const id = crypto.randomUUID(); movementIds.set(`${x.regime}:${x.sourceKey}`, id); if (!movementIds.has(x.sourceKey)) movementIds.set(x.sourceKey, id); movementStatuses.set(id, x.status); let movementNumber = x.movementNumber; while (usedMovementNumbers.has(movementNumber)) movementNumber = `${x.regime}-${movementNumber}`; usedMovementNumbers.add(movementNumber); await tx.insert(schema.movements).values({ id, organizationId: target.id, regime: x.regime, movementNumber, tripNumber: x.tripNumber, status: "draft", carrierCode: x.carrierCode, scheduledCrossingAt: dateOrNull(x.scheduledCrossingLocal), truckId: x.truckKey ? truckIds.get(x.truckKey) ?? null : null, isEmpty: x.isEmpty, iitIndicator: x.iitIndicator === "goods" ? "iit_importer_bond" : x.iitIndicator === "empty" ? "iit_carrier_bond" : "none", aciLvs: x.aciLvs, aciPostal: x.aciPostal, aciFlyingTruck: x.aciFlyingTruck, aciInTransit: x.aciInTransit, aciIit: x.aciIit, customsReferenceNumber: x.customsReferenceNumber, notes: x.notes }); }
  const shipmentIds = new Map<string, string>();
  const usedControls = new Set<string>();
  for (const x of bundle.shipments) { const id = crypto.randomUUID(); shipmentIds.set(x.sourceKey, id); let controlReference = (x.controlReference || x.sourceKey).toUpperCase().replace(/[^A-Z0-9]/g, ""); if (controlReference.length < 4) controlReference = `${controlReference}0000`.slice(0, 4); let controlNumber = `${x.carrierCode || ""}${controlReference}`; while (usedControls.has(controlNumber)) { controlReference = `${x.regime}${controlReference}`.slice(0, 20); controlNumber = `${x.carrierCode || ""}${controlReference}`; } usedControls.add(controlNumber); const movementId = x.movementKey ? movementIds.get(`${x.regime}:${x.movementKey}`) ?? movementIds.get(x.movementKey) ?? null : null; await tx.insert(schema.shipments).values({ id, organizationId: target.id, regime: x.regime, movementId, carrierCode: x.carrierCode || "", shipmentType: (x.shipmentType || (x.regime === "ACE" ? "regular_bill" : null)) as never, cargoType: (x.cargoType || (x.regime === "ACI" ? "regular" : null)) as never, controlReference, controlNumber, isPars: x.isPars, entryNumber: x.entryNumber, shipperId: x.shipperKey ? partnerIds.get(x.shipperKey) ?? null : null, consigneeId: x.consigneeKey ? partnerIds.get(x.consigneeKey) ?? null : null, loadingCountry: x.loadingCountry, loadingProvince: x.loadingProvince, loadingCity: x.loadingCity, deliveryAddress: x.deliveryAddress, status: x.status, notes: x.notes }); }
  for (const x of bundle.commodities) { const shipmentId = shipmentIds.get(x.shipmentKey); if (!shipmentId) continue; await tx.insert(schema.commodities).values({ shipmentId, organizationId: target.id, lineNumber: x.lineNumber, commodityDescription: x.commodityDescription || "Unspecified", weightKg: x.weightKg, weightUnit: x.weightUnit, quantity: x.quantity, quantityUnit: x.quantityUnit, marksAndNumbers: x.marksAndNumbers, isConsolidated: x.isConsolidated }); }
  for (const x of bundle.movementCrew) { const movementId = movementIds.get(x.movementKey); const driverId = driverIds.get(x.driverKey); if (!movementId || !driverId) continue; await tx.insert(schema.movementCrew).values({ organizationId: target.id, movementId, driverId, role: x.role, position: x.position }); }
  for (const x of bundle.movementTrailers) { const movementId = movementIds.get(x.movementKey); const trailerId = trailerIds.get(x.trailerKey); if (!movementId || !trailerId) continue; await tx.insert(schema.movementTrailers).values({ organizationId: target.id, movementId, trailerId, position: x.position }); }
  for (const x of bundle.movementEvents) { const movementId = movementIds.get(x.movementKey); if (!movementId) continue; await tx.insert(schema.movementEvents).values({ organizationId: target.id, movementId, shipmentId: x.shipmentKey ? shipmentIds.get(x.shipmentKey) ?? null : null, eventType: x.eventType, fromStatus: x.fromStatus, toStatus: x.toStatus, payload: x.payload, actorType: "system", occurredAt: dateOrNull(x.occurredAtLocal) ?? new Date() }); }
  for (const [id, status] of movementStatuses) {
    const path: Record<string, string[]> = { sent: ["sent"], accepted: ["sent", "accepted"], released: ["sent", "accepted", "released"], held: ["sent", "accepted", "held"], arrived: ["sent", "accepted", "released", "arrived"], rejected: ["sent", "rejected"], cancelled: ["cancelled"] };
    for (const next of path[status] ?? []) await tx.update(schema.movements).set({ status: next as never }).where(eq(schema.movements.id, id));
  }
  await tx.execute(sql`select 1`);
});
await client.end();
console.log("Avaal import committed");
