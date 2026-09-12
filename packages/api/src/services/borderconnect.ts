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
 * `alert`/`rns` messages (`SYSTEM_ALERT`/`RNS_SHIPMENT`) belong to no
 * tenant and are recognized-but-left-untouched here (Task 11 owns them):
 * `processed_at` stays null so a later drain — or Task 11's own logic —
 * can still find them, rather than this task guessing at handling and
 * silently marking them done.
 */
import { createHash } from "node:crypto";
import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  schema,
  withServiceRole,
  type DatabaseClient,
  type RlsTransaction,
} from "@corridor/db";
import { CUSTOMS_EVENT_LABELS } from "@corridor/domain";
import {
  createBorderConnectHttpTransport,
  createFixtureBorderConnectTransport,
  inboundKeys,
  parseInbound,
  type BorderConnectInbound,
  type BorderConnectTransport,
} from "@corridor/integrations";
import { applyStatusMessage, logIntegrationEvent } from "./customs";
import { lockMovement, requireMovement } from "./movements";

const { customsInbox, customsSubmissions, organizations, shipments } = schema;

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

function resolveTransport(opts?: { transport?: BorderConnectTransport }): BorderConnectTransport {
  if (opts?.transport) return opts.transport;
  const env = borderConnectEnv();
  if (env.live) {
    return createBorderConnectHttpTransport({ apiUrlSuffix: env.apiUrlSuffix!, apiKey: env.apiKey! });
  }
  // No live credentials and nothing injected: the same in-process fixture
  // queue `customsClientFor`'s border_connect client falls back to, drained
  // under a fixed "system" tenant key so `pnpm dev` end-to-end (transmit →
  // fixture queue → drain → accepted) has something to pull from without a
  // real BorderConnect account.
  return createFixtureBorderConnectTransport("system", () => new Date());
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
export async function storeInboundMessages(
  tx: RlsTransaction,
  messages: Record<string, unknown>[],
): Promise<{ stored: number; duplicates: number }> {
  let stored = 0;
  let duplicates = 0;
  for (const msg of messages) {
    const keys = inboundKeys(msg);
    const payloadSha256 = createHash("sha256").update(canonicalStringify(msg)).digest("hex");
    const inserted = await tx
      .insert(customsInbox)
      .values({
        provider: "border_connect",
        companyKey: keys.companyKey,
        dataType: keys.dataType,
        sendId: keys.sendId,
        tripNumber: keys.tripNumber,
        cargoControlNumber: keys.cargoControlNumber,
        shipmentControlNumber: keys.shipmentControlNumber,
        payload: msg,
        payloadSha256,
      })
      .onConflictDoNothing({ target: customsInbox.payloadSha256 })
      .returning({ id: customsInbox.id });
    if (inserted.length > 0) stored++;
    else duplicates++;
  }
  return { stored, duplicates };
}

/** api_response routing: correlation_id = sendId first, reference_number = tripNumber as a fallback. */
async function findSubmissionForApiResponse(
  tx: RlsTransaction,
  orgId: string,
  parsed: Extract<BorderConnectInbound, { kind: "api_response" }>,
): Promise<CustomsSubmissionRow | null> {
  if (parsed.sendId) {
    const [bySend] = await tx
      .select()
      .from(customsSubmissions)
      .where(
        and(
          eq(customsSubmissions.organizationId, orgId),
          eq(customsSubmissions.correlationId, parsed.sendId),
        ),
      )
      .orderBy(desc(customsSubmissions.createdAt))
      .limit(1);
    if (bySend) return bySend;
  }
  if (parsed.tripNumber) {
    const [byTrip] = await tx
      .select()
      .from(customsSubmissions)
      .where(
        and(
          eq(customsSubmissions.organizationId, orgId),
          eq(customsSubmissions.referenceNumber, parsed.tripNumber),
        ),
      )
      .orderBy(desc(customsSubmissions.createdAt))
      .limit(1);
    if (byTrip) return byTrip;
  }
  return null;
}

/**
 * customs_status routing: tripNumber against the submission's own
 * reference_number first (the normal case — the trip is still the filing
 * BorderConnect echoes back); a CCN/SCN-only message (most ACI_NOTICE
 * sub-types) falls back to `shipments.control_number` for the movement,
 * then that movement's latest submission for the reference to report back.
 */
async function findSubmissionForCustomsStatus(
  tx: RlsTransaction,
  orgId: string,
  keys: { tripNumber?: string; cargoControlNumber?: string; shipmentControlNumber?: string },
): Promise<CustomsSubmissionRow | null> {
  if (keys.tripNumber) {
    const [byTrip] = await tx
      .select()
      .from(customsSubmissions)
      .where(
        and(
          eq(customsSubmissions.organizationId, orgId),
          eq(customsSubmissions.referenceNumber, keys.tripNumber),
          isNotNull(customsSubmissions.movementId),
        ),
      )
      .orderBy(desc(customsSubmissions.createdAt))
      .limit(1);
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
      const [bySub] = await tx
        .select()
        .from(customsSubmissions)
        .where(
          and(
            eq(customsSubmissions.organizationId, orgId),
            eq(customsSubmissions.movementId, ship.movementId),
          ),
        )
        .orderBy(desc(customsSubmissions.createdAt))
        .limit(1);
      if (bySub) return bySub;
    }
  }
  return null;
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
      const [row] = await tx
        .select()
        .from(customsInbox)
        .where(eq(customsInbox.id, rowId))
        .limit(1);
      if (!row) throw new Error(`customs_inbox row ${rowId} not found`);
      if (row.processedAt) return { outcome: "ignored", detail: "already processed" };

      const parsed = parseInbound(row.payload);

      // Task 11 owns these two kinds — recognized here, left untouched.
      if (parsed.kind === "rns") return { outcome: "rns" };
      if (parsed.kind === "alert") return { outcome: "alert" };

      const companyKey = parsed.companyKey;
      const [org] = companyKey
        ? await tx
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.borderConnectCompanyKey, companyKey))
            .limit(1)
        : [];
      if (!org) {
        await markRow(tx, rowId, { processedAt: new Date(), processingError: "unknown companyKey" });
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
        const submission = await findSubmissionForApiResponse(tx, org.id, parsed);
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
        const m = await requireMovement(tx, org.id, submission.movementId);
        await applyStatusMessage(tx, { orgId: org.id, userId: null }, m, {
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
        });
        await markRow(tx, rowId, {
          organizationId: org.id,
          movementId: m.id,
          customsSubmissionId: submission.id,
          processedAt: new Date(),
        });
        return { outcome: "applied" };
      }

      // parsed.kind === "customs_status"
      const submission = await findSubmissionForCustomsStatus(tx, org.id, parsed.keys);
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
      await applyStatusMessage(tx, { orgId: org.id, userId: null }, m, {
        ...parsed.status,
        referenceNumber: submission.referenceNumber ?? parsed.status.referenceNumber,
      });
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

async function markRow(
  tx: RlsTransaction,
  rowId: number,
  patch: Partial<typeof customsInbox.$inferInsert>,
): Promise<void> {
  await tx.update(customsInbox).set(patch).where(eq(customsInbox.id, rowId));
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
  opts?: { transport?: BorderConnectTransport; limit?: number },
): Promise<{
  received: number;
  stored: number;
  duplicates: number;
  processed: Record<string, number>;
  errors: number;
}> {
  const transport = resolveTransport(opts);
  const messages = await transport.receive();
  const { stored, duplicates } = await withServiceRole(db, (tx) =>
    storeInboundMessages(tx, messages),
  );

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

  return { received: messages.length, stored, duplicates, processed, errors };
}

export type { CustomsInboxRow };
