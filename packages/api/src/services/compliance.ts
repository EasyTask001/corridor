/**
 * Applies the pure expiry rules (packages/domain/compliance) to registry rows:
 * upserts open alerts by dedupe_key and auto-resolves alerts whose underlying
 * document is no longer in breach (e.g. license renewed).
 *
 * Runs inside the caller's RLS transaction on save, and under a service-role
 * transaction (explicitly filtered by organization_id) in the nightly scan.
 */
import { and, eq, inArray, isNull, sql, type RlsTransaction } from "@corridor/db";
import { schema } from "@corridor/db";
import {
  driverDocuments,
  evaluateExpiries,
  todayIso,
  trailerDocuments,
  truckDocuments,
  type ExpiryEntityType,
  type ExpiryFinding,
} from "@corridor/domain";

const { complianceAlerts, drivers, trucks, trailers } = schema;

type DriverRow = typeof drivers.$inferSelect;
type TruckRow = typeof trucks.$inferSelect;
type TrailerRow = typeof trailers.$inferSelect;

export function findingsForDriver(d: DriverRow, today = todayIso()): ExpiryFinding[] {
  if (d.status === "archived") return [];
  return evaluateExpiries(
    { type: "driver", id: d.id, displayName: `${d.firstName} ${d.lastName}` },
    driverDocuments(d),
    today,
  );
}

export function findingsForTruck(t: TruckRow, today = todayIso()): ExpiryFinding[] {
  if (t.status === "archived") return [];
  return evaluateExpiries(
    { type: "truck", id: t.id, displayName: `Truck ${t.unitNumber}` },
    truckDocuments(t),
    today,
  );
}

export function findingsForTrailer(t: TrailerRow, today = todayIso()): ExpiryFinding[] {
  if (t.status === "archived") return [];
  return evaluateExpiries(
    { type: "trailer", id: t.id, displayName: `Trailer ${t.unitNumber}` },
    trailerDocuments(t),
    today,
  );
}

const entityColumn: Record<ExpiryEntityType, "driverId" | "truckId" | "trailerId"> = {
  driver: "driverId",
  truck: "truckId",
  trailer: "trailerId",
};

/**
 * Reconcile the set of open/acknowledged rule alerts for one entity with the
 * current findings. Returns counts for observability.
 */
export async function syncEntityAlerts(
  tx: RlsTransaction,
  organizationId: string,
  entity: { type: ExpiryEntityType; id: string },
  findings: ExpiryFinding[],
): Promise<{ created: number; updated: number; resolved: number }> {
  const col = entityColumn[entity.type];
  const existing = await tx
    .select({
      id: complianceAlerts.id,
      dedupeKey: complianceAlerts.dedupeKey,
      severity: complianceAlerts.severity,
      title: complianceAlerts.title,
    })
    .from(complianceAlerts)
    .where(
      and(
        eq(complianceAlerts.organizationId, organizationId),
        eq(complianceAlerts[col], entity.id),
        eq(complianceAlerts.source, "rules"),
        inArray(complianceAlerts.status, ["open", "acknowledged"]),
      ),
    );

  const byKey = new Map(existing.map((e) => [e.dedupeKey, e]));
  const wantedKeys = new Set(findings.map((f) => f.dedupeKey));
  let created = 0;
  let updated = 0;

  for (const f of findings) {
    const row = byKey.get(f.dedupeKey);
    const payload = {
      alertType: f.alertType,
      severity: f.severity,
      title: f.title,
      description: f.description,
      dueAt: f.dueAt,
      metadata: { field: f.field, label: f.label, daysRemaining: f.daysRemaining },
    };
    if (row) {
      if (row.severity !== f.severity || row.title !== f.title) {
        await tx.update(complianceAlerts).set(payload).where(eq(complianceAlerts.id, row.id));
        updated++;
      }
    } else {
      await tx.insert(complianceAlerts).values({
        organizationId,
        [col]: entity.id,
        dedupeKey: f.dedupeKey,
        source: "rules",
        ...payload,
      });
      created++;
    }
  }

  const stale = existing.filter((e) => e.dedupeKey && !wantedKeys.has(e.dedupeKey));
  if (stale.length) {
    await tx
      .update(complianceAlerts)
      .set({ status: "resolved", resolvedAt: sql`now()`, resolvedBy: null })
      .where(
        inArray(
          complianceAlerts.id,
          stale.map((s) => s.id),
        ),
      );
  }

  return { created, updated, resolved: stale.length };
}

/** Full scan for one organization — used by the nightly cron. */
export async function scanOrganization(
  tx: RlsTransaction,
  organizationId: string,
  today = todayIso(),
) {
  const totals = { created: 0, updated: 0, resolved: 0, entities: 0 };
  const add = (r: { created: number; updated: number; resolved: number }) => {
    totals.created += r.created;
    totals.updated += r.updated;
    totals.resolved += r.resolved;
    totals.entities++;
  };

  const [ds, ts, trs] = await Promise.all([
    tx
      .select()
      .from(drivers)
      .where(and(eq(drivers.organizationId, organizationId))),
    tx
      .select()
      .from(trucks)
      .where(and(eq(trucks.organizationId, organizationId))),
    tx
      .select()
      .from(trailers)
      .where(and(eq(trailers.organizationId, organizationId))),
  ]);

  for (const d of ds)
    add(
      await syncEntityAlerts(
        tx,
        organizationId,
        { type: "driver", id: d.id },
        findingsForDriver(d, today),
      ),
    );
  for (const t of ts)
    add(
      await syncEntityAlerts(
        tx,
        organizationId,
        { type: "truck", id: t.id },
        findingsForTruck(t, today),
      ),
    );
  for (const t of trs)
    add(
      await syncEntityAlerts(
        tx,
        organizationId,
        { type: "trailer", id: t.id },
        findingsForTrailer(t, today),
      ),
    );

  return totals;
}

export { isNull };
