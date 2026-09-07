import { TRPCError } from "@trpc/server";
import {
  and,
  desc,
  eq,
  isNotNull,
  notInArray,
  schema,
  sql,
  type RlsTransaction,
} from "@corridor/db";
import { isEditable, movementSuggestionPayload } from "@corridor/domain";
import { suggestMovement, type MovementFingerprint } from "@corridor/ai";
import { requireMovement } from "./movements";

const { movements, movementSuggestions, shipments, ports } = schema;

export async function generateMovementSuggestion(
  tx: RlsTransaction,
  orgId: string,
  userId: string,
  movementId: string,
) {
  const target = await requireMovement(tx, orgId, movementId);
  if (!isEditable(target.status)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Movement is not editable" });
  }

  const [targetLane] = await tx
    .select({ shipperId: shipments.shipperId, consigneeId: shipments.consigneeId })
    .from(shipments)
    .where(eq(shipments.movementId, movementId))
    .orderBy(shipments.createdAt)
    .limit(1);

  const history = await tx
    .select({
      id: movements.id,
      regime: movements.regime,
      portId: movements.portId,
      createdAt: movements.createdAt,
      shipperId: sql<
        string | null
      >`(select s.shipper_id from public.shipments s where s.movement_id = ${movements.id} order by s.created_at limit 1)`,
      consigneeId: sql<
        string | null
      >`(select s.consignee_id from public.shipments s where s.movement_id = ${movements.id} order by s.created_at limit 1)`,
    })
    .from(movements)
    .where(
      and(
        eq(movements.organizationId, orgId),
        eq(movements.regime, target.regime),
        notInArray(movements.status, ["draft", "rejected", "cancelled"]),
        isNotNull(movements.portId),
        isNotNull(movements.driverId),
        isNotNull(movements.truckId),
        sql`exists (
          select 1 from public.shipments complete
          where complete.movement_id = ${movements.id}
            and complete.shipper_id is not null
            and complete.consignee_id is not null
        )`,
      ),
    )
    .orderBy(desc(movements.createdAt))
    .limit(50);

  const fingerprint: MovementFingerprint = {
    id: target.id,
    regime: target.regime,
    // Identity comparison only (see similarity.ts) — the port's id serves
    // just as well as its code and needs no extra join here.
    crossingCode: target.portId ?? null,
    shipperId: targetLane?.shipperId ?? null,
    consigneeId: targetLane?.consigneeId ?? null,
    createdAt: target.createdAt,
  };
  const best = suggestMovement(
    fingerprint,
    history.map((candidate) => ({
      id: candidate.id,
      regime: candidate.regime,
      crossingCode: candidate.portId ?? null,
      shipperId: candidate.shipperId,
      consigneeId: candidate.consigneeId,
      createdAt: candidate.createdAt,
    })),
  );
  if (!best) return null;

  const [source] = await tx
    .select()
    .from(movements)
    .where(and(eq(movements.id, best.movementId), eq(movements.organizationId, orgId)))
    .limit(1);
  if (!source) return null;
  // Snapshot the source's port (id + code/name), not just its id, so the
  // suggestion still displays correctly even if the port catalogue changes.
  const sourcePort = source.portId
    ? await tx
        .select({ id: ports.id, code: ports.code, name: ports.name })
        .from(ports)
        .where(eq(ports.id, source.portId))
        .then((r) => r[0] ?? null)
    : null;

  const payload = movementSuggestionPayload.parse({
    sourceMovementId: source.id,
    sourceMovementNumber: source.movementNumber,
    targetUpdatedAt: target.updatedAt.toISOString(),
    port: sourcePort,
    carrierCode: source.carrierCode ?? null,
    driverId: source.driverId,
    truckId: source.truckId,
    trailerId: source.trailerId,
  });
  const [suggestion] = await tx
    .insert(movementSuggestions)
    .values({
      organizationId: orgId,
      movementId,
      sourceMovementId: source.id,
      score: best.score,
      reasons: best.reasons,
      suggestedPayload: payload,
      createdBy: userId,
    })
    .returning();
  return suggestion!;
}

export async function acceptMovementSuggestion(
  tx: RlsTransaction,
  orgId: string,
  suggestionId: string,
) {
  const [suggestion] = await tx
    .select()
    .from(movementSuggestions)
    .where(
      and(
        eq(movementSuggestions.id, suggestionId),
        eq(movementSuggestions.organizationId, orgId),
        eq(movementSuggestions.status, "offered"),
      ),
    )
    .limit(1);
  if (!suggestion) throw new TRPCError({ code: "NOT_FOUND", message: "Suggestion not found" });

  const payload = movementSuggestionPayload.parse(suggestion.suggestedPayload);
  const movement = await requireMovement(tx, orgId, suggestion.movementId);
  if (!isEditable(movement.status)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Movement is not editable" });
  }
  if (movement.updatedAt.toISOString() !== payload.targetUpdatedAt) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Movement changed after this suggestion was generated. Request a new suggestion.",
    });
  }

  const patch = {
    ...(!movement.portId && payload.port && { portId: payload.port.id }),
    ...(!movement.carrierCode && payload.carrierCode && { carrierCode: payload.carrierCode }),
    ...(!movement.driverId && payload.driverId && { driverId: payload.driverId }),
    ...(!movement.truckId && payload.truckId && { truckId: payload.truckId }),
    ...(!movement.trailerId && payload.trailerId && { trailerId: payload.trailerId }),
  };
  if (Object.keys(patch).length > 0) {
    await tx.update(movements).set(patch).where(eq(movements.id, movement.id));
  }

  const [decided] = await tx
    .update(movementSuggestions)
    .set({ status: "accepted", decidedAt: new Date() })
    .where(eq(movementSuggestions.id, suggestion.id))
    .returning();
  return decided!;
}

export async function dismissMovementSuggestion(
  tx: RlsTransaction,
  orgId: string,
  suggestionId: string,
) {
  const [decided] = await tx
    .update(movementSuggestions)
    .set({ status: "dismissed", decidedAt: new Date() })
    .where(
      and(
        eq(movementSuggestions.id, suggestionId),
        eq(movementSuggestions.organizationId, orgId),
        eq(movementSuggestions.status, "offered"),
      ),
    )
    .returning();
  if (!decided) throw new TRPCError({ code: "NOT_FOUND", message: "Suggestion not found" });
  return decided;
}
