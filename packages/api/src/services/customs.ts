/**
 * Customs transmission: build the e-manifest, call the (mock or real) gateway,
 * record an integration_events row either way, and on acknowledgement move
 * the manifest to `sent` and enqueue the asynchronous decision job.
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, schema, withServiceRole, type DatabaseClient, type RlsTransaction } from "@corridor/db";
import { canTransition, hasBlockingIssues, type MovementStatus } from "@corridor/domain";
import {
  CustomsTransportError,
  buildManifest,
  createCustomsClient,
  hasCustomsCredentials,
  providerForRegime,
  type CustomsClient,
  type CustomsClientSettings,
  type CustomsCredentials,
  type CustomsStatusMessage,
  type InboundCustomsMessage,
  type ManifestPayload,
} from "@corridor/integrations";
import { enqueueJob } from "./jobs";
import {
  applyCustomsDecision,
  applyTransition,
  loadFull,
  loadOrganization,
  lockMovement,
  markShipmentsSent,
  requireMovement,
  validationFor,
  type Actor,
  type FullMovement,
} from "./movements";

const { integrationConfigs, integrationEvents, customsSubmissions } = schema;

type MovementRow = typeof schema.movements.$inferSelect;

/** How long transmit keeps polling a gateway for a decision before giving up. */
export const POLL_WINDOW_MS = 48 * 60 * 60 * 1000;
export const POLL_INTERVAL_MS = 2 * 60 * 1000;

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
  const { data, error } = await admin.schema("api").rpc("read_integration_secret", {
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
  const mode = cfg?.mode ?? "mock";
  // The mock gateway in sandbox never needs (and never decrypts) the org's
  // real credentials; a gateway needs its API key whatever the environment.
  const credentials =
    (mode === "gateway" || environment === "production") && cfg?.credentialsRef
      ? await credentialsFor(orgId, provider)
      : undefined;
  return {
    client: createCustomsClient({
      regime,
      mode,
      environment,
      settings,
      credentials,
      baseUrl: cfg?.baseUrl ?? process.env.CUSTOMS_GATEWAY_BASE_URL ?? null,
      apiKey: credentials?.apiKey ?? process.env.CUSTOMS_GATEWAY_API_KEY ?? null,
      webhookSecret: process.env.CUSTOMS_GATEWAY_WEBHOOK_SECRET ?? null,
    }),
    config: cfg ?? null,
  };
}

/** Audit of one outbound filing (customs_submissions, 0023). */
export async function recordSubmission(
  tx: RlsTransaction,
  s: {
    orgId: string;
    movementId: string | null;
    kind: "original" | "amendment" | "cancel" | "in_bond";
    client: Pick<CustomsClient, "provider" | "mode">;
    referenceNumber: string | null;
    correlationId: string | null;
    status: "sent" | "acknowledged" | "failed";
    request?: Record<string, unknown> | null;
    response?: Record<string, unknown> | null;
  },
) {
  const [row] = await tx
    .insert(customsSubmissions)
    .values({
      organizationId: s.orgId,
      movementId: s.movementId,
      kind: s.kind,
      provider: s.client.provider,
      mode: s.client.mode,
      referenceNumber: s.referenceNumber,
      correlationId: s.correlationId,
      status: s.status,
      request: s.request ?? null,
      response: s.response ?? null,
    })
    .returning({ id: customsSubmissions.id });
  return row!;
}

/**
 * After an acknowledgement: the mock decides on its own clock
 * (`customs.decide`); a gateway is polled until it answers or the webhook
 * beats the poll to it (`customs.poll_status`).
 */
async function scheduleDecision(
  tx: RlsTransaction,
  orgId: string,
  client: Pick<CustomsClient, "mode">,
  payload: { movementId: string; referenceNumber: string; correlationId: string | null },
  etaMs: number,
) {
  if (client.mode === "gateway") {
    await enqueueJob(tx, {
      orgId,
      jobType: "customs.poll_status",
      payload: { ...payload, startedAt: new Date().toISOString() },
      runAt: new Date(Date.now() + etaMs),
      maxAttempts: 5,
    });
  } else {
    await enqueueJob(tx, {
      orgId,
      jobType: "customs.decide",
      payload,
      runAt: new Date(Date.now() + etaMs),
    });
  }
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
      isEmpty: full.isEmpty,
      iitIndicator: full.iitIndicator,
      aciLvs: full.aciLvs,
      aciPostal: full.aciPostal,
      aciFlyingTruck: full.aciFlyingTruck,
      aciInTransit: full.aciInTransit,
      aciIit: full.aciIit,
    },
    crew: full.crew,
    truck: full.truck
      ? {
          unitNumber: full.truck.unitNumber,
          vin: full.truck.vin,
          plateNumber: full.truck.plateNumber,
          plateJurisdiction: full.truck.plateJurisdiction,
          dotNumber: full.truck.dotNumber,
          insurancePolicyNumber: full.truck.insurancePolicyNumber,
          insuranceCompany: full.truck.insuranceCompany,
          insuranceAmount: full.truck.insuranceAmount,
          insuranceYear: full.truck.insuranceYear,
          plates: full.truck.plates,
          seals: full.seals.filter((s) => !s.movementTrailerId).map((s) => s.sealNumber),
        }
      : null,
    trailers: full.trailers.map((t) => ({
      unitNumber: t.unitNumber,
      trailerType: t.trailerType,
      plateNumber: t.plateNumber,
      plateJurisdiction: t.plateJurisdiction,
      plates: t.plates,
      seals: t.seals.map((s) => s.sealNumber),
    })),
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
    await recordSubmission(tx, {
      orgId: actor.orgId,
      movementId,
      kind: "original",
      client,
      referenceNumber: ack.referenceNumber,
      correlationId,
      status: "acknowledged",
      request: manifest as unknown as Record<string, unknown>,
      response: ack.raw,
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
        mode: client.mode,
        referenceNumber: ack.referenceNumber,
        warnings: issues.map((i) => i.code),
      },
    );
    // The movement itself is now `sent`; put its shipments in the one state
    // from which a customs decision can actually cascade to them.
    await markShipmentsSent(tx, movementId);
    await scheduleDecision(
      tx,
      actor.orgId,
      client,
      { movementId, referenceNumber: ack.referenceNumber, correlationId },
      ack.decisionEtaMs,
    );
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
      await recordSubmission(tx, {
        orgId: actor.orgId,
        movementId,
        kind: "original",
        client,
        referenceNumber: null,
        correlationId,
        status: "failed",
        request: manifest as unknown as Record<string, unknown>,
        response: { error: err.message, statusCode: err.statusCode },
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

/**
 * Re-file an accepted manifest after the router recorded the amendment and
 * moved the movement back to `sent`. A transport failure throws, which rolls
 * the whole amendment back: the manifest stays `accepted` as filed.
 */
export async function transmitAmendment(
  tx: RlsTransaction,
  actor: Actor,
  movementId: string,
  amendmentNumber: number,
) {
  const full = await loadFull(tx, actor.orgId, movementId);
  const ref = full.customsReferenceNumber;
  if (!ref) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Manifest has no customs reference" });
  }
  const org = await loadOrganization(tx, actor.orgId);
  const { client } = await customsClientFor(tx, actor.orgId, full.regime);
  const manifest = manifestFor(org, full);
  const correlationId = randomUUID();
  const started = Date.now();
  try {
    const ack = await client.amend(manifest, ref, { correlationId });
    await logIntegrationEvent(tx, {
      orgId: actor.orgId,
      movementId,
      provider: client.provider,
      direction: "outbound",
      operation: "amend",
      request: { amendmentNumber, referenceNumber: ref },
      response: { referenceNumber: ack.referenceNumber, receivedAt: ack.receivedAt, ...ack.raw },
      statusCode: 200,
      success: true,
      durationMs: Date.now() - started,
      correlationId,
    });
    await recordSubmission(tx, {
      orgId: actor.orgId,
      movementId,
      kind: "amendment",
      client,
      referenceNumber: ack.referenceNumber,
      correlationId,
      status: "acknowledged",
      request: { amendmentNumber, manifest },
      response: ack.raw,
    });
    await scheduleDecision(
      tx,
      actor.orgId,
      client,
      { movementId, referenceNumber: ack.referenceNumber, correlationId },
      ack.decisionEtaMs,
    );
    return ack;
  } catch (err) {
    if (err instanceof CustomsTransportError) {
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: err.retryable
          ? `${err.message}. The amendment was not transmitted — try again shortly.`
          : `${err.message}. Check the integration settings.`,
      });
    }
    throw err;
  }
}

/**
 * Tell the gateway a filed manifest is withdrawn. Only meaningful once a
 * reference exists (sent / accepted / held); a draft needs no call.
 */
export async function cancelAtCustoms(
  tx: RlsTransaction,
  actor: Actor,
  m: MovementRow,
  reason: string | null,
) {
  if (!m.customsReferenceNumber || !["sent", "accepted", "held"].includes(m.status)) return null;
  const { client } = await customsClientFor(tx, actor.orgId, m.regime);
  const correlationId = randomUUID();
  const started = Date.now();
  try {
    const ack = await client.cancel(m.customsReferenceNumber, reason);
    await logIntegrationEvent(tx, {
      orgId: actor.orgId,
      movementId: m.id,
      provider: client.provider,
      direction: "outbound",
      operation: "cancel",
      request: { referenceNumber: m.customsReferenceNumber, reason },
      response: ack.raw,
      statusCode: 200,
      success: true,
      durationMs: Date.now() - started,
      correlationId,
    });
    await recordSubmission(tx, {
      orgId: actor.orgId,
      movementId: m.id,
      kind: "cancel",
      client,
      referenceNumber: m.customsReferenceNumber,
      correlationId,
      status: "acknowledged",
      request: { reason },
      response: ack.raw,
    });
    return ack;
  } catch (err) {
    if (err instanceof CustomsTransportError) {
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: `${err.message}. The cancellation was not transmitted.`,
      });
    }
    throw err;
  }
}

/** The movement statuses a gateway status document walks through, from `from`. */
function stepsTowards(from: MovementStatus, target: MovementStatus): MovementStatus[] {
  if (from === target) return [];
  if (canTransition(from, target)) return [target];
  // sent → released / held go through accepted first.
  if (from === "sent" && canTransition("accepted", target)) return ["accepted", target];
  return [];
}

/**
 * Apply a gateway status document (from a poll or the webhook) to a movement:
 * transition as far as the document says, writing the customs events and
 * shipment outcomes on the final step, and stamp the filing's status.
 */
export async function applyStatusMessage(
  tx: RlsTransaction,
  actor: Actor,
  m: MovementRow,
  status: CustomsStatusMessage,
): Promise<{ changed: boolean; status: MovementStatus; terminal: boolean }> {
  let current = m;
  let changed = false;

  if (status.status === "cancelled") {
    if (current.status !== "cancelled" && canTransition(current.status, "cancelled")) {
      current = await applyTransition(tx, actor, current, "cancelled", "customs_api", {}, {
        referenceNumber: status.referenceNumber,
        message: status.message,
      });
      changed = true;
    }
  } else if (status.decision) {
    const steps = stepsTowards(current.status, status.decision);
    for (const [i, step] of steps.entries()) {
      const last = i === steps.length - 1;
      if (step === "accepted" || step === "rejected" || step === "released" || step === "held") {
        current = await applyCustomsDecision(tx, actor, current, {
          decision: step,
          referenceNumber: status.referenceNumber,
          message: last ? status.message : null,
          raw: last ? status.raw : undefined,
          events: last ? status.events : [],
          shipments: last ? status.shipments : [],
        });
        changed = true;
      }
    }
  }

  if (changed || status.status !== "pending") {
    await tx
      .update(customsSubmissions)
      .set({ status: status.status === "pending" ? "acknowledged" : status.status })
      .where(
        and(
          eq(customsSubmissions.organizationId, actor.orgId),
          eq(customsSubmissions.referenceNumber, status.referenceNumber),
        ),
      );
  }

  const terminal = ["released", "rejected", "arrived", "cancelled"].includes(current.status);
  return { changed, status: current.status, terminal };
}

export type PollPayload = {
  movementId: string;
  referenceNumber?: string | null;
  startedAt?: string | null;
  correlationId?: string | null;
};
export type PollResult = { status: string; changed: boolean; again: boolean; reason?: string };
export type PollPrepared =
  | { skip: true; result: PollResult }
  | {
      skip: false;
      m: MovementRow;
      ref: string;
      client: CustomsClient;
      config: typeof integrationConfigs.$inferSelect | null;
    };

/** Phase 1 of a poll: read the movement and build the client. Runs in a short transaction. */
export async function preparePoll(
  tx: RlsTransaction,
  orgId: string,
  payload: PollPayload,
): Promise<PollPrepared> {
  const m = await requireMovement(tx, orgId, payload.movementId);
  if (m.status !== "sent" && m.status !== "accepted" && m.status !== "held") {
    return { skip: true, result: { status: m.status, changed: false, again: false, reason: `movement is ${m.status}` } };
  }
  const ref = payload.referenceNumber ?? m.customsReferenceNumber;
  if (!ref) return { skip: true, result: { status: m.status, changed: false, again: false, reason: "no reference number" } };
  const { client, config } = await customsClientFor(tx, orgId, m.regime);
  return { skip: false, m, ref, client, config };
}

/** Phase 3 of a poll: log, stamp the config and apply the status document. Runs in its own transaction. */
export async function applyPoll(
  tx: RlsTransaction,
  orgId: string,
  prepared: Extract<PollPrepared, { skip: false }>,
  status: CustomsStatusMessage,
  meta: { durationMs: number; correlationId: string | null; startedAt: string | null },
): Promise<PollResult> {
  const { m, ref, client, config } = prepared;
  await logIntegrationEvent(tx, {
    orgId,
    movementId: m.id,
    provider: client.provider,
    direction: "inbound",
    operation: "poll",
    request: { referenceNumber: ref, currentStatus: m.status },
    response: { status: status.status, message: status.message, events: status.events.length },
    statusCode: 200,
    success: true,
    durationMs: meta.durationMs,
    correlationId: meta.correlationId,
  });
  if (config) {
    await tx.update(integrationConfigs).set({ lastPolledAt: new Date() }).where(eq(integrationConfigs.id, config.id));
  }
  // Re-read under lock: the snapshot in `prepared.m` predates the network call (Task 3).
  const current = await lockMovement(tx, orgId, m.id);
  if (current.status !== m.status) {
    return { status: current.status, changed: false, again: false, reason: "movement changed during poll" };
  }
  const result = await applyStatusMessage(tx, { orgId, userId: null }, current, status);
  const startedAt = meta.startedAt ? new Date(meta.startedAt).getTime() : Date.now();
  const withinWindow = Date.now() - startedAt < POLL_WINDOW_MS;
  return {
    status: result.status,
    changed: result.changed,
    again: !result.terminal && withinWindow,
    reason: result.terminal ? "terminal" : withinWindow ? undefined : "poll window elapsed",
  };
}

/**
 * One poll of a gateway-mode filing (`customs.poll_status` job): a short
 * transaction to prepare, the gateway call with NO transaction open, then a
 * short transaction to apply. Same three-phase shape as `customs.decide`.
 */
export async function pollCustomsStatus(
  db: DatabaseClient,
  orgId: string,
  payload: PollPayload,
): Promise<PollResult> {
  const prepared = await withServiceRole(db, (tx) => preparePoll(tx, orgId, payload));
  if (prepared.skip) return prepared.result;
  const started = Date.now();
  const status = await prepared.client.fetchStatus(prepared.ref);
  return withServiceRole(db, (tx) =>
    applyPoll(tx, orgId, prepared, status, {
      durationMs: Date.now() - started,
      correlationId: payload.correlationId ?? null,
      startedAt: payload.startedAt ?? null,
    }),
  );
}

/**
 * Webhook entry point: resolve the gateway's reference to a movement through
 * customs_submissions, apply once per event id, log the delivery. There is
 * no session behind a webhook, so this runs under the service role and
 * scopes everything by the submission's organization.
 */
export async function applyInboundCustomsMessage(
  db: DatabaseClient,
  message: InboundCustomsMessage,
): Promise<
  | { applied: boolean; status?: MovementStatus; duplicate?: boolean }
  | { applied: false; reason: "unknown reference" }
> {
  return withServiceRole(db, async (tx) => {
    const [sub] = await tx
      .select({ orgId: customsSubmissions.organizationId, movementId: customsSubmissions.movementId, provider: customsSubmissions.provider })
      .from(customsSubmissions)
      .where(eq(customsSubmissions.referenceNumber, message.referenceNumber))
      .orderBy(desc(customsSubmissions.createdAt))
      .limit(1);
    if (!sub?.movementId) return { applied: false as const, reason: "unknown reference" as const };

    const correlationId = `webhook:${message.eventId}`;
    const [seen] = await tx
      .select({ id: integrationEvents.id })
      .from(integrationEvents)
      .where(
        and(
          eq(integrationEvents.organizationId, sub.orgId),
          eq(integrationEvents.correlationId, correlationId),
        ),
      )
      .limit(1);
    if (seen) return { applied: false, duplicate: true };

    const m = await requireMovement(tx, sub.orgId, sub.movementId);
    await logIntegrationEvent(tx, {
      orgId: sub.orgId,
      movementId: m.id,
      provider: sub.provider,
      direction: "inbound",
      operation: "webhook",
      request: { eventId: message.eventId, referenceNumber: message.referenceNumber },
      response: { status: message.status, message: message.message, events: message.events.length },
      statusCode: 200,
      success: true,
      correlationId,
    });
    const result = await applyStatusMessage(tx, { orgId: sub.orgId, userId: null }, m, message);
    return { applied: result.changed, status: result.status };
  });
}
