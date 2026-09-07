/**
 * Customs transmission: build the e-manifest, call the (mock or real) gateway,
 * record an integration_events row either way, and on acknowledgement move
 * the manifest to `sent` and enqueue the asynchronous decision job.
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, schema, type RlsTransaction } from "@corridor/db";
import { hasBlockingIssues } from "@corridor/domain";
import {
  CustomsTransportError,
  buildManifest,
  createCustomsClient,
  hasCustomsCredentials,
  providerForRegime,
  type CustomsClientSettings,
  type CustomsCredentials,
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

/** Shape of the JSON document held in the Vault secret for a customs provider. */
const customsCredentialsSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    apiSecret: z.string().min(1).optional(),
    accountId: z.string().min(1).optional(),
  })
  .strip();

/**
 * Parse what the Vault handed back. Anything unexpected — malformed JSON, an
 * unknown shape, an all-blank document — degrades to "no credentials" rather
 * than throwing, so a bad secret cannot take transmit down. The plaintext is
 * never included in the warning.
 */
export function parseCustomsCredentials(
  raw: unknown,
  onWarn: (reason: string) => void = () => {},
): CustomsCredentials | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    onWarn("stored credentials are not valid JSON");
    return undefined;
  }
  const result = customsCredentialsSchema.safeParse(parsed);
  if (!result.success) {
    onWarn("stored credentials do not match the expected shape");
    return undefined;
  }
  return hasCustomsCredentials(result.data) ? result.data : undefined;
}

/**
 * Pull the org's decrypted gateway credentials.
 *
 * `read_integration_secret` is EXECUTE-revoked from `anon`/`authenticated`
 * (migration 0012), so this deliberately builds its own service-role client
 * rather than reusing the caller's — the plaintext must never be reachable
 * from a browser session. Failures are non-fatal: the mock gateway (and, later,
 * a real one returning 401) works the same either way, and a hard throw here
 * would take down transmit for a credential problem the dispatcher cannot fix.
 * Nothing from `data` is ever logged.
 */
async function credentialsFor(
  orgId: string,
  provider: "cbp_ace" | "cbsa_aci",
): Promise<CustomsCredentials | undefined> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn(
      `[customs] ${provider}: no service-role client configured — transmitting without credentials`,
    );
    return undefined;
  }
  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc("read_integration_secret", {
    p_org: orgId,
    p_provider: provider,
  });
  if (error) {
    console.warn(`[customs] ${provider}: credential read failed (${error.code ?? error.message})`);
    return undefined;
  }
  return parseCustomsCredentials(data, (reason) =>
    console.warn(`[customs] ${provider}: ${reason} — transmitting without credentials`),
  );
}

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
  const environment = cfg?.environment ?? "sandbox";
  // Sandbox always runs against the mock gateway, so it never needs (and never
  // decrypts) the org's real credentials.
  const credentials =
    environment === "production" && cfg?.credentialsRef
      ? await credentialsFor(orgId, provider)
      : undefined;
  return {
    client: createCustomsClient({ regime, environment, settings, credentials }),
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
      usDotNumber: org.usDotNumber,
      filerCode: org.filerCode,
    },
    movement: {
      regime: full.regime,
      movementNumber: full.movementNumber,
      tripNumber: full.tripNumber,
      carrierCode: full.carrierCode,
      port: full.port ? { code: full.port.code, name: full.port.name } : null,
      scheduledCrossingAt: full.scheduledCrossingAt,
    },
    crew: full.crew,
    truck: full.truck,
    trailer: full.trailer,
    seals: full.seals,
    shipments: full.shipments.map((s) => ({
      controlNumber: s.controlNumber,
      shipmentType: s.shipmentType,
      cargoType: s.cargoType,
      entryNumber: s.entryNumber,
      entryPortCode: s.entryPortCode,
      inBondEntryType: s.inBondEntryType,
      inBondDestinationPortCode: s.inBondDestinationPortCode,
      inBondNumber: s.inBondNumber,
      shipperName: s.shipperName,
      shipperAddress: s.shipperAddress,
      consigneeName: s.consigneeName,
      consigneeAddress: s.consigneeAddress,
      commodities: s.commodities,
    })),
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
