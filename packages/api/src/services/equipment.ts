/**
 * Equipment primitives shared by the registry router (extra plates on a truck
 * or trailer) and the movement workspace (`loadFull`): the trailers on one
 * crossing in tow order, each with its plates and seals. Migration 0021.
 */
import { asc, eq, inArray, or, schema, type RlsTransaction } from "@corridor/db";
import type { PlateEntry } from "@corridor/domain";

const { equipmentPlates, movementTrailers, trailers, seals } = schema;

export type Tx = RlsTransaction;

/** Which unit a plate is bolted to — exactly one, as the DB check demands. */
export type PlateOwner = { truckId: string } | { trailerId: string };

/** The extra plates on the given units, in position order. */
export async function platesFor(
  tx: Tx,
  ids: { truckIds?: string[]; trailerIds?: string[] },
): Promise<(typeof equipmentPlates.$inferSelect)[]> {
  const truckIds = ids.truckIds ?? [];
  const trailerIds = ids.trailerIds ?? [];
  if (truckIds.length === 0 && trailerIds.length === 0) return [];
  const conds = [];
  if (truckIds.length) conds.push(inArray(equipmentPlates.truckId, truckIds));
  if (trailerIds.length) conds.push(inArray(equipmentPlates.trailerId, trailerIds));
  return tx
    .select()
    .from(equipmentPlates)
    .where(or(...conds))
    .orderBy(asc(equipmentPlates.position));
}

/** Replace a unit's extra plates (positions 1..3) in one go — like `writeHazmat`. */
export async function writePlates(
  tx: Tx,
  orgId: string,
  owner: PlateOwner,
  entries: PlateEntry[],
): Promise<void> {
  await tx
    .delete(equipmentPlates)
    .where(
      "truckId" in owner
        ? eq(equipmentPlates.truckId, owner.truckId)
        : eq(equipmentPlates.trailerId, owner.trailerId),
    );
  if (entries.length === 0) return;
  await tx.insert(equipmentPlates).values(
    entries.map((p, i) => ({
      organizationId: orgId,
      ...owner,
      plateNumber: p.plateNumber,
      jurisdiction: p.jurisdiction,
      position: i + 1,
    })),
  );
}

/**
 * The trailers on one movement in tow order, each with its registry record,
 * its extra plates and the seals recorded on it.
 */
export async function trailersForMovement(tx: Tx, movementId: string) {
  const rows = await tx
    .select({
      id: movementTrailers.id,
      trailerId: movementTrailers.trailerId,
      position: movementTrailers.position,
      unitNumber: trailers.unitNumber,
      trailerType: trailers.trailerType,
      vin: trailers.vin,
      plateNumber: trailers.plateNumber,
      plateJurisdiction: trailers.plateJurisdiction,
      registrationExpiry: trailers.registrationExpiry,
      insuranceExpiry: trailers.insuranceExpiry,
      annualInspectionExpiry: trailers.annualInspectionExpiry,
      lengthFt: trailers.lengthFt,
      status: trailers.status,
    })
    .from(movementTrailers)
    .innerJoin(trailers, eq(trailers.id, movementTrailers.trailerId))
    .where(eq(movementTrailers.movementId, movementId))
    .orderBy(asc(movementTrailers.position), asc(movementTrailers.createdAt));

  const [plates, sealRows] = await Promise.all([
    platesFor(tx, { trailerIds: rows.map((r) => r.trailerId) }),
    rows.length
      ? tx
          .select()
          .from(seals)
          .where(
            inArray(
              seals.movementTrailerId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(asc(seals.createdAt))
      : [],
  ]);

  return rows.map((r) => ({
    ...r,
    plates: plates.filter((p) => p.trailerId === r.trailerId),
    seals: sealRows.filter((s) => s.movementTrailerId === r.id),
  }));
}
