/**
 * The BorderConnect inbox drain (0047, Task 10): BorderConnect's Service
 * Provider API has no per-tenant webhook — every message (ack, decision,
 * ACI notice, RNS release, system alert) lands in one shared queue behind
 * `GET /api/receive/{suffix}`, tagged with the filing org's `companyKey`
 * rather than delivered to it directly. `drainBorderConnectInbox` is the
 * job body (`customs.borderconnect_drain`, run every minute by
 * `apps/web/src/app/api/jobs/borderconnect-drain/route.ts`): pull the
 * queue, store every message durably in `customs_inbox` BEFORE
 * interpreting any of it (so a bug in routing can never lose a message —
 * only delay it), then route and apply each unprocessed row.
 *
 * `alert` (`SYSTEM_ALERT`) and `rns` (`RNS_SHIPMENT`) messages belong to no
 * single tenant — an alert fans out to every org (`recordCarrierNotices`,
 * shared with `syncCarrierNotices`'s own carrier-notice sync), and an RNS
 * release is routed by `shipments.control_number` across every org (there is
 * no companyKey on RNS_SHIPMENT — see `findShipmentsForRns` below).
 */
import { createHash } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  schema,
  withServiceRole,
  type DatabaseClient,
  type RlsTransaction,
} from "@corridor/db";
import { CUSTOMS_EVENT_LABELS } from "@corridor/domain";
import { corridorMetrics } from "@corridor/observability";
import {
  createBorderConnectHttpTransport,
  createFixtureBorderConnectTransport,
  createBorderConnectSpool,
  FIXTURE_BORDERCONNECT_TENANT_KEY,
  inboundKeys,
  isAciReleaseCode,
  parseInbound,
  type BorderConnectTransport,
  type CarrierNotice,
} from "@corridor/integrations";
import { applyStatusMessage, logIntegrationEvent } from "./customs";
import { lockMovement, recordCustomsEvents, stampShipmentStatus } from "./movements";
import { recordCarrierNotices } from "./notices";

const { customsInbox, customsSubmissions, movements, organizations, parsRnsEvents, shipments } =
  schema;

type CustomsInboxRow = typeof customsInbox.$inferSelect;
type CustomsSubmissionRow = typeof customsSubmissions.$inferSelect;

/** The deployment-wide BorderConnect credentials `customsClientFor` also reads (services/customs.ts). */
export function borderConnectEnv(): {
  apiUrlSuffix: string | null;
  apiKey: string | null;
  live: boolean;
} {
  const apiUrlSuffix = process.env.BORDERCONNECT_API_URL_SUFFIX ?? null;
  const apiKey = process.env.BORDERCONNECT_API_KEY ?? null;
  return { apiUrlSuffix, apiKey, live: !!(apiUrlSuffix && apiKey) };
}

function resolveTransport(opts?: {
  transport?: BorderConnectTransport;
  environment?: "sandbox" | "production";
}): BorderConnectTransport {
  if (opts?.transport) return opts.transport;
  const env = borderConnectEnv();
  const environment =
    opts?.environment ??
    (process.env.VERCEL_ENV === "production" || process.env.CORRIDOR_ENV === "production"
      ? "production"
      : "sandbox");
  if (environment === "production" && !env.live) {
    throw new Error("BorderConnect production receive credentials are not configured");
  }
  if (environment === "production") {
    return createBorderConnectHttpTransport({
      apiUrlSuffix: env.apiUrlSuffix!,
      apiKey: env.apiKey!,
    });
  }
  // No live credentials and nothing injected: the same in-process fixture
  // queue `customsClientFor`'s border_connect client falls back to, drained
  // under the one shared tenant key both sides agree on
  // (`FIXTURE_BORDERCONNECT_TENANT_KEY`, never the org id — the real
  // BorderConnect inbox is deployment-wide too) so `pnpm dev` end-to-end
  // (transmit → fixture queue → drain → accepted) has something to pull from
  // without a real BorderConnect account.
  return createFixtureBorderConnectTransport(FIXTURE_BORDERCONNECT_TENANT_KEY, () => new Date());
}

function requiredSpool(environment: "sandbox" | "production") {
  if (environment !== "production") return null;
  const spool = createBorderConnectSpool();
  if (!spool) {
    throw new Error(
      "BORDERCONNECT_SPOOL_DIR and a 32-byte BORDERCONNECT_SPOOL_KEY are required before polling a live BorderConnect queue",
    );
  }
  return spool;
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively (at
 * every nesting level), array element order is preserved. Plain
 * `JSON.stringify` serializes object keys in insertion order, so two
 * logically identical messages that happen to arrive with differently
 * ordered keys (an HTTP retry re-serialized by BorderConnect, an
 * intermediate proxy, a different JSON encoder on their end) would hash
 * differently and silently evade dedup — this is the canonical form
 * `storeInboundMessages` hashes instead, so key order can never matter.
 */
export function canonicalStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalStringify(item))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",");
  return `{${body}}`;
}

/**
 * Store every message the queue handed back BEFORE any of it is
 * interpreted. Dedup key is `sha256(canonicalStringify(message))` — the same
 * message re-delivered by an HTTP retry or an overlapping poll (even with its
 * object keys re-ordered along the way) hashes identically and
 * `payload_sha256`'s unique constraint no-ops the insert.
 */
// A drain cycle after downtime can pull a large batch; chunking keeps one
// INSERT's parameter count sane rather than bounding it on row count alone.
const INSERT_CHUNK_SIZE = 500;

export async function storeInboundMessages(
  tx: RlsTransaction,
  messages: Record<string, unknown>[],
): Promise<{ stored: number; duplicates: number }> {
  if (messages.length === 0) return { stored: 0, duplicates: 0 };
  const rows = messages.map((msg) => {
    const keys = inboundKeys(msg);
    return {
      provider: "border_connect" as const,
      companyKey: keys.companyKey,
      dataType: keys.dataType,
      sendId: keys.sendId,
      tripNumber: keys.tripNumber,
      cargoControlNumber: keys.cargoControlNumber,
      shipmentControlNumber: keys.shipmentControlNumber,
      payload: msg,
      payloadSha256: createHash("sha256").update(canonicalStringify(msg)).digest("hex"),
    };
  });
  let stored = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
    // `ON CONFLICT DO NOTHING` tolerates duplicate values within the same
    // statement (unlike DO UPDATE, it never re-touches a row twice), so two
    // identical messages in one drain batch dedupe here exactly as two
    // messages across separate calls would.
    const inserted = await tx
      .insert(customsInbox)
      .values(chunk)
      .onConflictDoNothing({ target: customsInbox.payloadSha256 })
      .returning({ id: customsInbox.id });
    stored += inserted.length;
  }
  return { stored, duplicates: messages.length - stored };
}

async function latestSubmission(
  tx: RlsTransaction,
  ...conditions: Parameters<typeof and>
): Promise<CustomsSubmissionRow | null> {
  const [row] = await tx
    .select()
    .from(customsSubmissions)
    .where(and(...conditions))
    .orderBy(desc(customsSubmissions.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Shared submission-routing fallback chain: sendId (correlation_id) → trip
 * number (reference_number) → CCN/SCN via the shipment it's attached to. Both
 * inbound message kinds use it, with one difference: an `api_response` (the
 * initial send ack, before a movement is necessarily linked yet) matches a
 * trip number with no `movementId` filter, while a `customs_status` message
 * only trusts a trip-number match that already has a movement attached —
 * `findShipmentsForRns` stays a separate function (RNS carries no companyKey
 * at all, so it searches by CCN across every organization and returns
 * shipments, not submissions — a genuinely different contract, not the same
 * one repeated).
 */
async function resolveSubmission(
  tx: RlsTransaction,
  orgId: string,
  keys: {
    sendId?: string | null;
    tripNumber?: string | null;
    cargoControlNumber?: string | null;
    shipmentControlNumber?: string | null;
  },
  opts: { requireMovement: boolean },
): Promise<CustomsSubmissionRow | null> {
  if (keys.sendId) {
    const bySend = await latestSubmission(
      tx,
      eq(customsSubmissions.organizationId, orgId),
      eq(customsSubmissions.correlationId, keys.sendId),
    );
    if (bySend) return bySend;
  }
  if (keys.tripNumber) {
    const byTrip = await latestSubmission(
      tx,
      eq(customsSubmissions.organizationId, orgId),
      eq(customsSubmissions.referenceNumber, keys.tripNumber),
      ...(opts.requireMovement ? [isNotNull(customsSubmissions.movementId)] : []),
    );
    if (byTrip) return byTrip;
  }
  const ccn = keys.cargoControlNumber ?? keys.shipmentControlNumber;
  if (ccn) {
    const [ship] = await tx
      .select({ movementId: shipments.movementId })
      .from(shipments)
      .where(
        and(
          eq(shipments.organizationId, orgId),
          eq(shipments.controlNumber, ccn),
          isNotNull(shipments.movementId),
        ),
      )
      .limit(1);
    if (ship?.movementId) {
      const bySub = await latestSubmission(
        tx,
        eq(customsSubmissions.organizationId, orgId),
        eq(customsSubmissions.movementId, ship.movementId),
      );
      if (bySub) return bySub;
    }
  }
  return null;
}

/**
 * RNS routing (Task 11): `RNS_SHIPMENT` carries no companyKey — CBSA's
 * Release Notification System has no concept of a filing "company account",
 * only the PARS cargo control number — and `shipments.control_number` is
 * unique only per organization
 * (`shipments_organization_id_control_number_key`), so this must search
 * across every org rather than assume one. Every candidate is then narrowed
 * to the ACI movements still `sent`/`accepted`/`held` — a shipment whose
 * movement is ACE (RNS is CBSA's system; an ACE shipment can never be
 * RNS-released), is done (`released`, `rejected`, `cancelled`, `arrived`) or
 * has none yet is not a plausible target for a fresh release notice. That
 * narrowing runs even for a single match, not just to break a tie: a lone
 * global CCN hit on the wrong regime or a finished movement must be
 * unroutable, never silently applied. Only when exactly one candidate
 * remains is the message routed at all.
 */
async function findShipmentsForRns(tx: RlsTransaction, cargoControlNumber: string) {
  const candidates = await tx
    .select({
      id: shipments.id,
      organizationId: shipments.organizationId,
      movementId: shipments.movementId,
      status: shipments.status,
    })
    .from(shipments)
    .where(eq(shipments.controlNumber, cargoControlNumber));

  // Applied unconditionally, not only to break a tie: a single global match is
  // still the wrong target when it belongs to an ACE movement (RNS is CBSA's
  // system — an ACE shipment can never be RNS-released) or to a movement that
  // is done (`cancelled`/`arrived`/`released`/`rejected`) or has none at all.
  // Short-circuiting on `candidates.length <= 1` would route those anyway.
  const movementIds = [
    ...new Set(candidates.map((c) => c.movementId).filter((id): id is string => !!id)),
  ];
  const eligible = movementIds.length
    ? await tx
        .select({ id: movements.id })
        .from(movements)
        .where(
          and(
            inArray(movements.id, movementIds),
            eq(movements.regime, "ACI"),
            inArray(movements.status, ["sent", "accepted", "held"]),
          ),
        )
    : [];
  const eligibleIds = new Set(eligible.map((m) => m.id));
  return candidates.filter((c) => c.movementId && eligibleIds.has(c.movementId));
}

type ProcessOutcome = {
  outcome: "applied" | "acknowledged" | "unroutable" | "ignored" | "rns" | "alert";
  detail?: string;
};

/**
 * The routing + apply logic for one `customs_inbox` row, run inside one
 * `withServiceRole` transaction — never one transaction for the whole
 * batch, so a bug on row 5 cannot roll back rows 1-4 (`drainBorderConnectInbox`
 * calls this once per row).
 *
 * On an unexpected throw: `processing_error` is stamped with the message
 * and `processed_at` stays null so the next drain retries — except after 5
 * attempts (tracked in the `attempt=N: ` prefix of `processing_error`
 * itself; the table has no dedicated retry-count column, Task 2), when the
 * row is marked processed anyway so one permanently broken message cannot
 * poison every future drain forever.
 */
export async function processInboxRow(db: DatabaseClient, rowId: number): Promise<ProcessOutcome> {
  try {
    return await withServiceRole(db, async (tx): Promise<ProcessOutcome> => {
      // `for update skip locked`, held for the life of this transaction: the
      // cron drain and a Settings "Check inbox" click can overlap, and nothing
      // downstream dedupes a second `customs_event` / `pars_rns_events` write
      // (`applyTransition`'s compare-and-swap only blocks a duplicate *status*
      // change). Whoever gets the lock processes the row; the loser skips it
      // rather than blocking, and finds it `processed_at`-stamped next drain.
      const [row] = await tx
        .select()
        .from(customsInbox)
        .where(eq(customsInbox.id, rowId))
        .for("update", { skipLocked: true })
        .limit(1);
      if (!row) {
        // `skip locked` returns nothing for both "gone" and "someone else has
        // it" — tell them apart before treating this as an error.
        const [unlocked] = await tx
          .select({ id: customsInbox.id })
          .from(customsInbox)
          .where(eq(customsInbox.id, rowId))
          .limit(1);
        if (unlocked) return { outcome: "ignored", detail: "locked by another worker" };
        throw new Error(`customs_inbox row ${rowId} not found`);
      }
      if (row.processedAt) return { outcome: "ignored", detail: "already processed" };

      const parsed = parseInbound(row.payload);

      if (parsed.kind === "rns") {
        const candidates = await findShipmentsForRns(tx, parsed.cargoControlNumber);
        if (candidates.length !== 1) {
          const error =
            candidates.length === 0
              ? "unknown CCN"
              : `ambiguous CCN (${candidates.length} candidates)`;
          await markRow(tx, rowId, { processedAt: new Date(), processingError: error });
          return { outcome: "unroutable", detail: error };
        }
        const shipment = candidates[0]!;
        const releasedAt = new Date(parsed.releasedAt);

        // Always logged to the PARS RNS feed (0027), regardless of whether
        // this particular code denotes a release — same column shape
        // `recordCustomsEvents` writes for a decision that carries RNS
        // fields (movements.ts).
        await tx.insert(parsRnsEvents).values({
          organizationId: shipment.organizationId,
          shipmentId: shipment.id,
          parsNumber: parsed.cargoControlNumber,
          releaseCode: parsed.releaseCode,
          releasedAt,
          officeCode: parsed.officeCode,
          transactionNumber: parsed.transactionNumber,
          raw: parsed.raw,
        });

        if (isAciReleaseCode(parsed.releaseCode)) {
          await stampShipmentStatus(tx, shipment.id, shipment.status, "released");
          if (shipment.movementId) {
            const m = await lockMovement(tx, shipment.organizationId, shipment.movementId);
            await recordCustomsEvents(
              tx,
              { orgId: shipment.organizationId, userId: null },
              m,
              [
                {
                  code: "released",
                  label: CUSTOMS_EVENT_LABELS.released,
                  occurredAt: releasedAt.toISOString(),
                  entryPortCode: parsed.officeCode,
                  // Deliberately not set: `recordCustomsEvents` would itself
                  // insert a second, duplicate `pars_rns_events` row keyed off
                  // `raw.rns === true` + a matching shipmentControlNumber —
                  // the audit row above is already that insert.
                  shipmentControlNumber: null,
                  raw: {
                    rns: true,
                    releaseCode: parsed.releaseCode,
                    officeCode: parsed.officeCode,
                    transactionNumber: parsed.transactionNumber,
                    cargoControlNumber: parsed.cargoControlNumber,
                  },
                },
              ],
              [],
            );
          }
        }

        await markRow(tx, rowId, {
          organizationId: shipment.organizationId,
          movementId: shipment.movementId,
          processedAt: new Date(),
        });
        return { outcome: "rns" };
      }

      if (parsed.kind === "alert") {
        const notices: CarrierNotice[] = (["cbp_ace", "cbsa_aci"] as const).map((provider) => ({
          provider,
          // Reuses the row's own dedup hash (simplest — it's already computed
          // and stored) rather than hashing the message again; suffixed per
          // provider because `carrier_notices.external_id` is unique across
          // the whole table, not per provider, and this branch always writes
          // one row per provider for the same alert.
          externalId: `borderconnect:${row.payloadSha256}:${provider}`,
          severity: "warning",
          title: "BorderConnect system alert",
          body: parsed.message,
          startsAt: null,
          endsAt: null,
          publishedAt: row.receivedAt.toISOString(),
        }));
        await recordCarrierNotices(tx, notices);
        await markRow(tx, rowId, { processedAt: new Date() });
        return { outcome: "alert" };
      }

      const companyKey = parsed.companyKey;
      const [org] = companyKey
        ? await tx
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.borderConnectCompanyKey, companyKey))
            .limit(1)
        : [];
      if (!org) {
        await markRow(tx, rowId, {
          processedAt: new Date(),
          processingError: "unknown companyKey",
        });
        return { outcome: "unroutable", detail: "unknown companyKey" };
      }

      if (parsed.kind === "unknown") {
        await markRow(tx, rowId, {
          organizationId: org.id,
          processedAt: new Date(),
          processingError: `unhandled data type ${parsed.dataType}`,
        });
        return { outcome: "ignored", detail: `unhandled data type ${parsed.dataType}` };
      }

      if (parsed.kind === "api_response") {
        const submission = await resolveSubmission(
          tx,
          org.id,
          { sendId: parsed.sendId, tripNumber: parsed.tripNumber },
          { requireMovement: false },
        );
        if (!submission) {
          await markRow(tx, rowId, {
            organizationId: org.id,
            processedAt: new Date(),
            processingError: "no matching customs_submission",
          });
          return { outcome: "unroutable", detail: "no matching customs_submission" };
        }
        if (parsed.ok) {
          if (submission.status === "sent" || submission.status === "acknowledged") {
            await tx
              .update(customsSubmissions)
              .set({ status: "acknowledged" })
              .where(eq(customsSubmissions.id, submission.id));
          }
          await markRow(tx, rowId, {
            organizationId: org.id,
            movementId: submission.movementId,
            customsSubmissionId: submission.id,
            processedAt: new Date(),
          });
          return { outcome: "acknowledged" };
        }
        if (!submission.movementId) {
          await markRow(tx, rowId, {
            organizationId: org.id,
            customsSubmissionId: submission.id,
            processedAt: new Date(),
            processingError: "submission has no movement",
          });
          return { outcome: "unroutable", detail: "submission has no movement" };
        }
        // `lockMovement`, not `requireMovement`: this branch applies a status
        // change, exactly like the `customs_status` branch below — both take
        // the movement's row lock so two workers can never interleave a
        // read-modify-write on the same movement.
        const m = await lockMovement(tx, org.id, submission.movementId);
        await applyStatusMessage(
          tx,
          { orgId: org.id, userId: null },
          m,
          {
            referenceNumber: submission.referenceNumber ?? parsed.tripNumber ?? "",
            status: "rejected",
            decision: "rejected",
            message: parsed.message || `BorderConnect: ${parsed.status}`,
            events: [
              {
                code: "import_error",
                label: CUSTOMS_EVENT_LABELS.import_error,
                occurredAt: new Date().toISOString(),
                raw: parsed.raw,
              },
            ],
            shipments: [],
            raw: parsed.raw,
          },
          submission.id,
        );
        await markRow(tx, rowId, {
          organizationId: org.id,
          movementId: m.id,
          customsSubmissionId: submission.id,
          processedAt: new Date(),
        });
        return { outcome: "applied" };
      }

      // parsed.kind === "customs_status"
      const submission = await resolveSubmission(tx, org.id, parsed.keys, {
        requireMovement: true,
      });
      if (!submission?.movementId) {
        await markRow(tx, rowId, {
          organizationId: org.id,
          processedAt: new Date(),
          processingError: "no movement found for these keys",
        });
        return { outcome: "unroutable", detail: "no movement found for these keys" };
      }
      const m = await lockMovement(tx, org.id, submission.movementId);
      await logIntegrationEvent(tx, {
        orgId: org.id,
        movementId: m.id,
        provider: "border_connect",
        direction: "inbound",
        operation: `borderconnect.${row.dataType.toLowerCase()}`,
        correlationId: `bc-inbox:${rowId}`,
        request: { keys: parsed.keys },
        response: {
          status: parsed.status.status,
          decision: parsed.status.decision,
          events: parsed.status.events.length,
        },
        statusCode: 200,
        success: true,
      });
      await applyStatusMessage(
        tx,
        { orgId: org.id, userId: null },
        m,
        {
          ...parsed.status,
          referenceNumber: submission.referenceNumber ?? parsed.status.referenceNumber,
        },
        submission.id,
      );
      await markRow(tx, rowId, {
        organizationId: org.id,
        movementId: m.id,
        customsSubmissionId: submission.id,
        processedAt: new Date(),
      });
      return { outcome: "applied" };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The transaction above may have aborted at the Postgres level (a failed
    // query, not just a JS throw) — bookkeeping runs in a fresh transaction
    // so a poisoned attempt can never block its own retry accounting.
    return withServiceRole(db, async (tx) => {
      const [current] = await tx
        .select({ processingError: customsInbox.processingError })
        .from(customsInbox)
        .where(eq(customsInbox.id, rowId))
        .limit(1);
      const prevAttempt = Number(current?.processingError?.match(/^attempt=(\d+):/)?.[1] ?? "0");
      const attempt = prevAttempt + 1;
      const detail = `attempt=${attempt}: ${message}`;
      await markRow(tx, rowId, {
        processingError: detail,
        ...(attempt >= 5 ? { processedAt: new Date() } : {}),
      });
      return { outcome: "unroutable" as const, detail };
    });
  }
}

/**
 * Every write to a `customs_inbox` row goes through here, and
 * `processing_error` is cleared by default: a row that failed once (leaving
 * `attempt=1: …` behind) and then succeeded on a retry must not keep showing
 * the stale failure text in the Settings inbox list. A caller that genuinely
 * has an error to record passes `processingError` itself and overrides the
 * default — including the retry bookkeeping in `processInboxRow`'s catch.
 */
async function markRow(
  tx: RlsTransaction,
  rowId: number,
  patch: Partial<typeof customsInbox.$inferInsert>,
): Promise<void> {
  await tx
    .update(customsInbox)
    .set({ processingError: null, ...patch })
    .where(eq(customsInbox.id, rowId));
}

/**
 * The `customs.borderconnect_drain` job body: pull the shared queue, store
 * every message (phase B, service role), then process whatever is still
 * unprocessed (phase C, one transaction per row — includes rows a previous
 * run left behind after a throw). `logIntegrationEvent` is per-row and
 * org-scoped, so the drain itself has nothing global to log — only counts.
 */
export async function drainBorderConnectInbox(
  db: DatabaseClient,
  opts?: {
    transport?: BorderConnectTransport;
    limit?: number;
    environment?: "sandbox" | "production";
  },
): Promise<{
  received: number;
  stored: number;
  duplicates: number;
  processed: Record<string, number>;
  errors: number;
}> {
  const transport = resolveTransport(opts);
  const environment =
    opts?.environment ??
    (process.env.VERCEL_ENV === "production" || process.env.CORRIDOR_ENV === "production"
      ? "production"
      : "sandbox");
  const spool = requiredSpool(environment);
  let stored = 0;
  let duplicates = 0;
  const spoolBatches = spool ? await spool.read() : [];
  for (const batch of spoolBatches) {
    const result = await withServiceRole(db, (tx) => storeInboundMessages(tx, batch.messages));
    stored += result.stored;
    duplicates += result.duplicates;
    await spool!.remove(batch.id);
  }

  const messages = await transport.receive();
  if (spool && messages.length > 0) {
    const batch = await spool.write(messages);
    const result = await withServiceRole(db, (tx) => storeInboundMessages(tx, messages));
    stored += result.stored;
    duplicates += result.duplicates;
    // The encrypted batch remains on disk if the database write rejects. The
    // job fails so the watchdog retries it, but no pop-on-read message is lost.
    if (batch) await spool.remove(batch.id);
  } else {
    const result = await withServiceRole(db, (tx) => storeInboundMessages(tx, messages));
    stored += result.stored;
    duplicates += result.duplicates;
  }

  const limit = opts?.limit ?? 200;
  const pending = await withServiceRole(db, (tx) =>
    tx
      .select({ id: customsInbox.id })
      .from(customsInbox)
      .where(isNull(customsInbox.processedAt))
      .orderBy(customsInbox.id)
      .limit(limit),
  );

  const processed: Record<string, number> = {};
  let errors = 0;
  for (const { id } of pending) {
    const result = await processInboxRow(db, id);
    processed[result.outcome] = (processed[result.outcome] ?? 0) + 1;
    if (result.detail?.startsWith("attempt=")) errors++;
  }

  corridorMetrics.customsInbox({
    received: messages.length,
    stored,
    processed: Object.values(processed).reduce((sum, count) => sum + count, 0),
    duplicates,
    unroutable: processed.unroutable ?? 0,
    failed: errors,
  });
  return { received: messages.length, stored, duplicates, processed, errors };
}

export type { CustomsInboxRow };

/**
 * Reset one poison/unroutable inbox row after an operator fixes its mapping.
 * Ownership is checked against the row's tenant, the now-corrected company
 * key, or the sole eligible ACI shipment for an RNS message. The payload is
 * never returned to the caller and the reset is deliberately idempotent.
 */
export async function reprocessInboxRow(
  db: DatabaseClient,
  orgId: string,
  rowId: number,
): Promise<{ id: number }> {
  return withServiceRole(db, async (tx) => {
    const [row] = await tx
      .select({
        id: customsInbox.id,
        organizationId: customsInbox.organizationId,
        companyKey: customsInbox.companyKey,
        payload: customsInbox.payload,
        processedAt: customsInbox.processedAt,
        processingError: customsInbox.processingError,
      })
      .from(customsInbox)
      .where(eq(customsInbox.id, rowId))
      .limit(1);
    if (!row) throw new Error("customs inbox row not found");
    if (
      !row.processingError ||
      !/unknown|ambiguous|no (matching )?movement/i.test(row.processingError)
    ) {
      throw new Error("only an unroutable or ambiguous inbox row can be reprocessed");
    }

    let owned = row.organizationId === orgId;
    if (!owned && row.companyKey) {
      const [org] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.id, orgId),
            eq(organizations.borderConnectCompanyKey, row.companyKey),
          ),
        )
        .limit(1);
      owned = !!org;
    }
    if (!owned) {
      const parsed = parseInbound(row.payload);
      if (parsed.kind === "rns") {
        const [candidate] = await tx
          .select({ id: shipments.id })
          .from(shipments)
          .innerJoin(movements, eq(movements.id, shipments.movementId))
          .where(
            and(
              eq(shipments.organizationId, orgId),
              eq(shipments.controlNumber, parsed.cargoControlNumber),
              eq(movements.organizationId, orgId),
              eq(movements.regime, "ACI"),
              inArray(movements.status, ["sent", "accepted", "held"]),
            ),
          )
          .limit(1);
        owned = !!candidate;
      }
    }
    if (!owned) throw new Error("inbox row does not belong to this organization");

    await tx
      .update(customsInbox)
      .set({ organizationId: orgId, processedAt: null, processingError: null })
      .where(eq(customsInbox.id, rowId));
    return { id: rowId };
  });
}
