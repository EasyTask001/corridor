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

const { movements, movementSuggestions, cargo } = schema;

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
    .select({ shipperId: cargo.shipperId, consigneeId: cargo.consigneeId })
    .from(cargo)
    .where(eq(cargo.movementId, movementId))
    .orderBy(cargo.lineNumber)
    .limit(1);

  const history = await tx
    .select({
      id: movements.id,
      regime: movements.regime,
      crossingPoint: movements.crossingPoint,
      createdAt: movements.createdAt,
      shipperId: sql<
        string | null
      >`(select c.shipper_id from public.cargo c where c.movement_id = ${movements.id} order by c.line_number limit 1)`,
      consigneeId: sql<
        string | null
      >`(select c.consignee_id from public.cargo c where c.movement_id = ${movements.id} order by c.line_number limit 1)`,
    })
    .from(movements)
    .where(
      and(
        eq(movements.organizationId, orgId),
        eq(movements.regime, target.regime),
        notInArray(movements.status, ["draft", "rejected", "cancelled"]),
        isNotNull(movements.crossingPoint),
        isNotNull(movements.driverId),
        isNotNull(movements.truckId),
        sql`exists (
          select 1 from public.cargo complete
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
    crossingCode: target.crossingPoint?.code ?? null,
    shipperId: targetLane?.shipperId ?? null,
    consigneeId: targetLane?.consigneeId ?? null,
    createdAt: target.createdAt,
  };
  const best = suggestMovement(
    fingerprint,
    history.map((candidate) => ({
      id: candidate.id,
      regime: candidate.regime,
      crossingCode: candidate.crossingPoint?.code ?? null,
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
  const sourceCargo = await tx
    .select({
      shipperId: cargo.shipperId,
      consigneeId: cargo.consigneeId,
      commodityDescription: cargo.commodityDescription,
      hsCode: cargo.hsCode,
      weightKg: cargo.weightKg,
      pieceCount: cargo.pieceCount,
      packagingType: cargo.packagingType,
      valueAmount: cargo.valueAmount,
      valueCurrency: cargo.valueCurrency,
      countryOfOrigin: cargo.countryOfOrigin,
    })
    .from(cargo)
    .where(eq(cargo.movementId, source.id))
    .orderBy(cargo.lineNumber);

  const payload = movementSuggestionPayload.parse({
    sourceMovementId: source.id,
    sourceMovementNumber: source.movementNumber,
    targetUpdatedAt: target.updatedAt.toISOString(),
    crossingPoint: source.crossingPoint ?? null,
    driverId: source.driverId,
    truckId: source.truckId,
    trailerId: source.trailerId,
    cargo: sourceCargo,
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
    ...(!movement.crossingPoint &&
      payload.crossingPoint && {
        crossingPoint: payload.crossingPoint,
      }),
    ...(!movement.driverId && payload.driverId && { driverId: payload.driverId }),
    ...(!movement.truckId && payload.truckId && { truckId: payload.truckId }),
    ...(!movement.trailerId && payload.trailerId && { trailerId: payload.trailerId }),
  };
  if (Object.keys(patch).length > 0) {
    await tx.update(movements).set(patch).where(eq(movements.id, movement.id));
  }

  const [existingCargo] = await tx
    .select({ id: cargo.id })
    .from(cargo)
    .where(eq(cargo.movementId, movement.id))
    .limit(1);
  if (!existingCargo && payload.cargo.length > 0) {
    await tx.insert(cargo).values(
      payload.cargo.map((line, index) => ({
        ...line,
        movementId: movement.id,
        organizationId: orgId,
        lineNumber: index + 1,
      })),
    );
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
