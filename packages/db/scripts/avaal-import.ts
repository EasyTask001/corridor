import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { createDb, schema } from "../src/client";
import { mapAvaalSnapshot } from "../src/avaal-import/mapping";

const snapshotPath = process.argv[2];
const execute = process.argv.includes("--execute");
if (!snapshotPath) throw new Error("usage: avaal:import <snapshot.json> [--execute]");
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const bundle = mapAvaalSnapshot(snapshot);
if (!bundle.organization) throw new Error("Avaal company record is missing");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const { db, sql: client } = createDb(url, { max: 1 });

if (!execute) {
  console.log(JSON.stringify({ dryRun: true, organization: bundle.organization.name, drivers: bundle.drivers.length, trucks: bundle.trucks.length, trailers: bundle.trailers.length, partners: bundle.partners.length, movements: bundle.movements.length, shipments: bundle.shipments.length, commodities: bundle.commodities.length, blocking: bundle.exceptions.filter((e) => e.blocking).length }, null, 2));
  await client.end();
  process.exit(0);
}

await db.transaction(async (tx) => {
  const [target] = await tx.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.name, "PATHFINDER TRANS INC.")).limit(1);
  if (!target) throw new Error("Pathfinder test organization not found; refusing replacement");
  await tx.delete(schema.organizations).where(eq(schema.organizations.id, target.id));
  await tx.insert(schema.organizations).values({ id: target.id, ...bundle.organization!, billingAddress: bundle.organization!.billingAddress });

  if (bundle.carrierCodes.length) await tx.insert(schema.organizationCarrierCodes).values(bundle.carrierCodes.map((x) => ({ organizationId: target.id, regime: x.regime, code: x.code, isDefault: x.isDefault })));
  const driverIds = new Map<string, string>();
  for (const x of bundle.drivers) { const id = crypto.randomUUID(); driverIds.set(x.sourceKey, id); await tx.insert(schema.drivers).values({ id, organizationId: target.id, firstName: x.firstName, lastName: x.lastName, licenseNumber: x.licenseNumber, licenseJurisdiction: x.licenseJurisdiction, dateOfBirth: x.dateOfBirth, citizenship: x.citizenship, phone: x.phone, email: x.email, gender: x.gender, hazmatEndorsement: x.hazmatEndorsement, usAddress: x.address, smsOptIn: x.smsOptIn, smsPhoneAce: x.smsPhoneAce, smsPhoneAci: x.smsPhoneAci, status: x.status }); }
  const truckIds = new Map<string, string>();
  for (const x of bundle.trucks) { const id = crypto.randomUUID(); truckIds.set(x.sourceKey, id); await tx.insert(schema.trucks).values({ id, organizationId: target.id, unitNumber: x.unitNumber, vin: x.vin, plateNumber: x.plateNumber, plateJurisdiction: x.plateJurisdiction, transponderNumber: x.transponderNumber, dotNumber: x.dotNumber, hazmatCapable: x.hazmatCapable, insuranceCompany: x.insuranceCompany, insurancePolicyNumber: x.insurancePolicyNumber, insuranceAmount: x.insuranceAmount, insuranceYear: x.insuranceYear, status: x.status }); }
  const trailerIds = new Map<string, string>();
  for (const x of bundle.trailers) { const id = crypto.randomUUID(); trailerIds.set(x.sourceKey, id); await tx.insert(schema.trailers).values({ id, organizationId: target.id, unitNumber: x.unitNumber, trailerType: x.trailerType || "TF", plateNumber: x.plateNumber, plateJurisdiction: x.plateJurisdiction, status: x.status }); }
  const partnerIds = new Map<string, string>();
  for (const x of bundle.partners) { const id = crypto.randomUUID(); for (const key of x.sourceKeys) partnerIds.set(key, id); await tx.insert(schema.partners).values({ id, organizationId: target.id, name: x.name, type: x.type, address: x.address, contactName: x.contactName, contactEmail: x.contactEmail, contactPhone: x.contactPhone, status: x.status }); }
  const movementIds = new Map<string, string>();
  for (const x of bundle.movements) { const id = crypto.randomUUID(); movementIds.set(x.sourceKey, id); await tx.insert(schema.movements).values({ id, organizationId: target.id, regime: x.regime, movementNumber: x.movementNumber, tripNumber: x.tripNumber, status: x.status, carrierCode: x.carrierCode, scheduledCrossingAt: x.scheduledCrossingLocal ? new Date(x.scheduledCrossingLocal) : null, truckId: x.truckKey ? truckIds.get(x.truckKey) ?? null : null, isEmpty: x.isEmpty, iitIndicator: x.iitIndicator === "goods" ? "iit_importer_bond" : x.iitIndicator === "empty" ? "iit_carrier_bond" : "none", aciLvs: x.aciLvs, aciPostal: x.aciPostal, aciFlyingTruck: x.aciFlyingTruck, aciInTransit: x.aciInTransit, aciIit: x.aciIit, customsReferenceNumber: x.customsReferenceNumber, notes: x.notes }); }
  const shipmentIds = new Map<string, string>();
  for (const x of bundle.shipments) { const id = crypto.randomUUID(); shipmentIds.set(x.sourceKey, id); await tx.insert(schema.shipments).values({ id, organizationId: target.id, regime: x.regime, movementId: x.movementKey ? movementIds.get(x.movementKey) ?? null : null, carrierCode: x.carrierCode || "", shipmentType: x.shipmentType as never, cargoType: x.cargoType as never, controlReference: x.controlReference, controlNumber: `${x.carrierCode || ""}${x.controlReference}`, isPars: x.isPars, entryNumber: x.entryNumber, shipperId: x.shipperKey ? partnerIds.get(x.shipperKey) ?? null : null, consigneeId: x.consigneeKey ? partnerIds.get(x.consigneeKey) ?? null : null, loadingCountry: x.loadingCountry, loadingProvince: x.loadingProvince, loadingCity: x.loadingCity, deliveryAddress: x.deliveryAddress, status: x.status, notes: x.notes }); }
  for (const x of bundle.commodities) { const shipmentId = shipmentIds.get(x.shipmentKey); if (!shipmentId) continue; await tx.insert(schema.commodities).values({ shipmentId, organizationId: target.id, lineNumber: x.lineNumber, commodityDescription: x.commodityDescription || "Unspecified", weightKg: x.weightKg, weightUnit: x.weightUnit, quantity: x.quantity, quantityUnit: x.quantityUnit, marksAndNumbers: x.marksAndNumbers, isConsolidated: x.isConsolidated }); }
  await tx.execute(sql`select 1`);
});
await client.end();
console.log("Avaal import committed");
