/**
 * Customs transmission: build the e-manifest, call the (mock or real) gateway,
 * record an integration_events row either way, and on acknowledgement move
 * the manifest to `sent` and enqueue the asynchronous decision job.
 */
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, schema, type RlsTransaction } from "@corridor/db";
import { hasBlockingIssues } from "@corridor/domain";
import {
  CustomsTransportError,
  buildManifest,
  createCustomsClient,
  providerForRegime,
  type CustomsClientSettings,
  type ManifestPayload,
} from "@corridor/integrations";
import { enqueueJob } from "./jobs";
import {
  applyTransition,
  loadFull,
  loadOrganization,
  validationFor,
  type Actor,
  type FullMovement,
} from "./movements";

const { integrationConfigs, integrationEvents } = schema;

export async function customsClientFor(tx: RlsTransaction, orgId: string, regime: "ACE" | "ACI") {
  const provider = providerForRegime(regime);
  const [cfg] = await tx
    .select()
    .from(integrationConfigs)
    .where(
      and(eq(integrationConfigs.organizationId, orgId), eq(integrationConfigs.provider, provider)),
    )
    .limit(1);
  if (cfg?.status === "disabled") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${provider === "cbp_ace" ? "CBP ACE" : "CBSA ACI"} integration is disabled for this organization`,
    });
  }
  const settings = (cfg?.settings ?? {}) as CustomsClientSettings;
  return {
    client: createCustomsClient({ regime, environment: cfg?.environment ?? "sandbox", settings }),
    config: cfg ?? null,
  };
}

export function manifestFor(
  org: Awaited<ReturnType<typeof loadOrganization>>,
  full: FullMovement,
): ManifestPayload {
  return buildManifest({
    organization: {
      name: org.name,
      scacCode: org.scacCode,
      canadianCarrierCode: org.canadianCarrierCode,
      usDotNumber: org.usDotNumber,
    },
    movement: {
      regime: full.regime,
      movementNumber: full.movementNumber,
      tripNumber: full.tripNumber,
      crossingPoint: full.crossingPoint ?? null,
      scheduledCrossingAt: full.scheduledCrossingAt,
    },
    driver: full.driver,
    truck: full.truck,
    trailer: full.trailer,
    seals: full.seals,
    cargo: full.cargo,
  });
}

export async function logIntegrationEvent(
  tx: RlsTransaction,
  e: {
    orgId: string;
    movementId?: string | null;
    provider: string;
    direction: "outbound" | "inbound";
    operation: string;
    request?: Record<string, unknown> | null;
    response?: Record<string, unknown> | null;
    statusCode?: number | null;
    success: boolean;
    error?: string | null;
    durationMs?: number;
    correlationId?: string | null;
  },
) {
  await tx.insert(integrationEvents).values({
    organizationId: e.orgId,
    movementId: e.movementId ?? null,
    provider: e.provider,
    direction: e.direction,
    operation: e.operation,
    requestPayload: e.request ?? null,
    responsePayload: e.response ?? null,
    statusCode: e.statusCode ?? null,
    success: e.success,
    errorMessage: e.error ?? null,
    durationMs: e.durationMs ?? null,
    correlationId: e.correlationId ?? null,
  });
}

/**
 * Transmit a draft/rejected movement. Runs inside the caller's RLS transaction;
 * the integration_events row is written in BOTH the success and failure paths
 * (the failure path re-throws, but the caller's transaction is committed by
 * the router because we catch inside and log before throwing — see below).
 */
export async function transmitMovement(tx: RlsTransaction, actor: Actor, movementId: string) {
  const full = await loadFull(tx, actor.orgId, movementId);
  const issues = validationFor(full);
  if (hasBlockingIssues(issues)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Cannot transmit: ${issues
        .filter((i) => i.severity === "blocking")
        .map((i) => i.message)
        .join(" ")}`,
    });
  }
  // Refresh risk findings right before transmit so hold-prediction reflects
  // the final manifest content (dispatcher sees it on the Review step too).
  // Dynamic import: risk.ts -> notifications.ts -> customs.ts would otherwise cycle.
  const { syncMovementRiskAlerts } = await import("./risk");
  await syncMovementRiskAlerts(tx, actor.orgId, movementId);

  const org = await loadOrganization(tx, actor.orgId);
  const { client } = await customsClientFor(tx, actor.orgId, full.regime);
  const manifest = manifestFor(org, full);
  const correlationId = randomUUID();
  const started = Date.now();

  try {
    const ack = await client.transmit(manifest, { correlationId });
    await logIntegrationEvent(tx, {
      orgId: actor.orgId,
      movementId,
      provider: client.provider,
      direction: "outbound",
      operation: "transmit",
      request: manifest as unknown as Record<string, unknown>,
      response: { referenceNumber: ack.referenceNumber, receivedAt: ack.receivedAt, ...ack.raw },
      statusCode: 200,
      success: true,
      durationMs: Date.now() - started,
      correlationId,
    });
    const updated = await applyTransition(
      tx,
      actor,
      full,
      "sent",
      "user",
      { customsReferenceNumber: ack.referenceNumber },
      {
        regime: full.regime,
        provider: client.provider,
        environment: client.environment,
        referenceNumber: ack.referenceNumber,
        warnings: issues.map((i) => i.code),
      },
    );
    await enqueueJob(tx, {
      orgId: actor.orgId,
      jobType: "customs.decide",
      payload: { movementId, referenceNumber: ack.referenceNumber, correlationId },
      runAt: new Date(Date.now() + ack.decisionEtaMs),
    });
    return {
      movement: updated,
      referenceNumber: ack.referenceNumber,
      decisionEtaMs: ack.decisionEtaMs,
    };
  } catch (err) {
    if (err instanceof CustomsTransportError) {
      // Persist the failure for the integration log. The router commits this
      // by converting the error into a TRPCError *after* the transaction.
      await logIntegrationEvent(tx, {
        orgId: actor.orgId,
        movementId,
        provider: client.provider,
        direction: "outbound",
        operation: "transmit",
        request: manifest as unknown as Record<string, unknown>,
        statusCode: err.statusCode,
        success: false,
        error: err.message,
        durationMs: Date.now() - started,
        correlationId,
      });
      return {
        movement: full,
        transportError: {
          message: err.message,
          statusCode: err.statusCode,
          retryable: err.retryable,
        },
      };
    }
    throw err;
  }
}
