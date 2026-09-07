/**
 * Wires the pure risk-detection engine (packages/ai) to live data: builds
 * lane history from past movements, calls evaluateMovementRisk, and syncs
 * the findings into compliance_alerts the same way compliance.ts does for
 * expiry alerts (upsert-by-dedupe-key, auto-resolve what's no longer true).
 */
import { evaluateMovementRisk, type RiskFinding } from "@corridor/ai";
import { lookupHsCode } from "@corridor/integrations";
import { and, desc, eq, inArray, ne, notInArray, or, schema, sql, type RlsTransaction } from "@corridor/db";
import { notifyOrganization } from "./notifications";

const { movements, cargo, partners, complianceAlerts } = schema;

const LANE_HISTORY_LIMIT = 12;
const REJECTED_WINDOW_DAYS = 90;

async function laneHistory(
  tx: RlsTransaction,
  orgId: string,
  movement: typeof movements.$inferSelect,
) {
  // "Lane" = same shipper+consignee if cargo already has them, else same crossing + regime.
  const [firstLine] = await tx
    .select({ shipperId: cargo.shipperId, consigneeId: cargo.consigneeId })
    .from(cargo)
    .where(eq(cargo.movementId, movement.id))
    .limit(1);

  const laneCond =
    firstLine?.shipperId && firstLine?.consigneeId
      ? sql`exists (
          select 1 from public.cargo c2
          where c2.movement_id = ${movements.id}
            and c2.shipper_id = ${firstLine.shipperId}
            and c2.consignee_id = ${firstLine.consigneeId}
        )`
      : sql`${movements.regime} = ${movement.regime}
            and ${movements.crossingPoint} ->> 'code' = ${movement.crossingPoint?.code ?? null}`;

  const past = await tx
    .select({
      id: movements.id,
      status: movements.status,
      rejectedAt: movements.rejectedAt,
      weightKg: cargo.weightKg,
      valueAmount: cargo.valueAmount,
    })
    .from(movements)
    .leftJoin(cargo, eq(cargo.movementId, movements.id))
    .where(
      and(
        eq(movements.organizationId, orgId),
        ne(movements.id, movement.id),
        notInArray(movements.status, ["draft", "cancelled"]),
        laneCond,
      ),
    )
    .orderBy(desc(movements.createdAt))
    .limit(LANE_HISTORY_LIMIT * 3); // multiple cargo rows per movement

  const seenMovements = new Set(past.map((p) => p.id)).size;
  const weights = past.map((p) => p.weightKg).filter((x): x is number => x != null);
  const values = past.map((p) => p.valueAmount).filter((x): x is number => x != null);
  const rejectedRecently = past.some(
    (p) =>
      p.status === "rejected" &&
      p.rejectedAt &&
      Date.now() - p.rejectedAt.getTime() < REJECTED_WINDOW_DAYS * 86_400_000,
  );

  return { weights, values, rejectedRecently, sampleMovements: seenMovements };
}

export async function computeMovementRisk(
  tx: RlsTransaction,
  orgId: string,
  movementId: string,
): Promise<RiskFinding[]> {
  const [movement] = await tx
    .select()
    .from(movements)
    .where(and(eq(movements.id, movementId), eq(movements.organizationId, orgId)));
  if (!movement) return [];

  const [cargoRows, lane] = await Promise.all([
    tx
      .select({
        lineNumber: cargo.lineNumber,
        commodityDescription: cargo.commodityDescription,
        hsCode: cargo.hsCode,
        weightKg: cargo.weightKg,
        valueAmount: cargo.valueAmount,
      })
      .from(cargo)
      .where(eq(cargo.movementId, movementId)),
    laneHistory(tx, orgId, movement),
  ]);

  if (cargoRows.length === 0) return [];

  let hasBroker = false;
  const firstLine = cargoRows[0];
  if (firstLine) {
    const [consignee] = await tx
      .select({ type: partners.type })
      .from(partners)
      .where(eq(partners.type, "broker"))
      .limit(1);
    hasBroker = !!consignee; // org has at least one broker on file — used as a coarse signal
  }

  return evaluateMovementRisk({
    movementId,
    hasBroker,
    cargo: cargoRows,
    lane: { weights: lane.weights, values: lane.values, rejectedRecently: lane.rejectedRecently },
    lookupTariff: lookupHsCode,
  });
}

/** Upsert-by-dedupe-key against existing 'rules'-sourced risk alerts for this movement. */
export async function syncMovementRiskAlerts(
  tx: RlsTransaction,
  orgId: string,
  movementId: string,
) {
  const findings = await computeMovementRisk(tx, orgId, movementId);

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
        eq(complianceAlerts.organizationId, orgId),
        eq(complianceAlerts.movementId, movementId),
        eq(complianceAlerts.source, "rules"),
        or(
          eq(complianceAlerts.alertType, "hs_code_mismatch"),
          eq(complianceAlerts.alertType, "risk_flag"),
          eq(complianceAlerts.alertType, "hold_prediction"),
        ),
        sql`${complianceAlerts.status} in ('open','acknowledged')`,
      ),
    );
  const byKey = new Map(existing.map((e) => [e.dedupeKey, e]));
  const wanted = new Set(findings.map((f) => f.dedupeKey));

  let created = 0;
  for (const f of findings) {
    const row = byKey.get(f.dedupeKey);
    if (row) {
      if (row.severity !== f.severity || row.title !== f.title) {
        await tx
          .update(complianceAlerts)
          .set({
            severity: f.severity,
            title: f.title,
            description: f.description,
            metadata: f.metadata,
          })
          .where(eq(complianceAlerts.id, row.id));
      }
      continue;
    }
    await tx.insert(complianceAlerts).values({
      organizationId: orgId,
      movementId,
      alertType: f.alertType,
      severity: f.severity,
      source: "rules",
      title: f.title,
      description: f.description,
      dedupeKey: f.dedupeKey,
      metadata: f.metadata,
    });
    created++;
    if (f.severity === "critical") {
      await notifyOrganization(tx, {
        orgId,
        eventType: "alert.critical",
        title: f.title,
        body: f.description,
        linkPath: `/movements/${movementId}`,
      });
    }
  }

  const stale = existing.filter((e) => e.dedupeKey && !wanted.has(e.dedupeKey));
  if (stale.length) {
    await tx
      .update(complianceAlerts)
      .set({ status: "resolved", resolvedAt: sql`now()` })
      .where(
        inArray(
          complianceAlerts.id,
          stale.map((s) => s.id),
        ),
      );
  }

  return { created, resolved: stale.length, total: findings.length };
}
