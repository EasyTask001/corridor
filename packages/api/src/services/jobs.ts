/**
 * Postgres-table job queue. Producers enqueue inside their own transaction;
 * a worker (cron route / `after()` hook) claims due jobs with
 * FOR UPDATE SKIP LOCKED under the service role and dispatches by type.
 */
import {
  and,
  eq,
  inArray,
  schema,
  sql,
  withServiceRole,
  type DatabaseClient,
  type RlsTransaction,
} from "@corridor/db";
import {
  POLL_INTERVAL_MS,
  customsClientFor,
  logIntegrationEvent,
  manifestFor,
  pollCustomsStatus,
} from "./customs";
import {
  applyCustomsDecision,
  loadFull,
  loadOrganization,
  lockMovement,
  requireMovement,
} from "./movements";
import { recordUsage, reportPendingUsage } from "./usage";

const { backgroundJobs, movements } = schema;

export type JobType =
  | "customs.decide"
  | "customs.poll_status"
  | "customs.notices_sync"
  | "driver.notify"
  | "compliance.scan"
  | "document.extract"
  | "copilot.embed_knowledge"
  | "billing.report_usage"
  | "notification.push";

export async function enqueueJob(
  tx: RlsTransaction,
  job: {
    orgId: string | null;
    jobType: JobType;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
    runAt?: Date;
    maxAttempts?: number;
  },
) {
  const [row] = await tx
    .insert(backgroundJobs)
    .values({
      organizationId: job.orgId,
      jobType: job.jobType,
      payload: job.payload,
      idempotencyKey: job.idempotencyKey,
      runAt: job.runAt ?? new Date(),
      maxAttempts: job.maxAttempts ?? 3,
    })
    .returning({ id: backgroundJobs.id, runAt: backgroundJobs.runAt });
  return row!;
}

type Job = typeof backgroundJobs.$inferSelect;
type Handler = (tx: RlsTransaction, job: Job) => Promise<Record<string, unknown> | void>;

/**
 * The transactional dispatch table. Exported so a test can drive one handler
 * directly rather than racing every other worker for a claim; `processDueJobs`
 * is the only production caller. Partial because `billing.report_usage`
 * lives in `detachedJobHandlers` below; every JobType appears in exactly one of
 * the two, and `processDueJobs` throws for a type in neither.
 */
export const jobHandlers: Partial<Record<JobType, Handler>> = {
  /**
   * Deliver the Expo pushes for one notification fan-out. The producer runs
   * inside a user's RLS transaction and cannot reach `push_tokens_for` (granted
   * to `service_role` only) without taking a second pooled connection while its
   * own is still held — so it enqueues this instead, and the worker, which
   * already holds the service role, does the sending.
   *
   * The payload carries only row ids; the text and the recipients are re-read
   * from `notifications`.
   */
  "notification.push": async (tx, job) => {
    const orgId = job.organizationId;
    if (!orgId) throw new Error("notification.push requires organization_id");
    const ids = Array.isArray(job.payload.notificationIds)
      ? job.payload.notificationIds.filter((id): id is string => typeof id === "string")
      : [];
    // Dynamic import: notifications.ts imports enqueueJob from here.
    const { deliverQueuedPush } = await import("./notifications");
    return deliverQueuedPush(tx, orgId, ids);
  },

  /** Driver sheet + entry numbers to dispatch and the driver (0025). */
  "driver.notify": async (tx, job) => {
    if (!job.organizationId) throw new Error("driver.notify requires organization_id");
    const trigger = job.payload.trigger === "entries_complete" ? "entries_complete" : "accepted";
    const { runDriverNotify } = await import("./driver-notify");
    return runDriverNotify(tx, job.organizationId, {
      movementId: String(job.payload.movementId),
      trigger,
    });
  },

  /** Hourly (vercel.json → /api/jobs/notices-sync): pull CBP/CBSA notices, fan out. */
  "customs.notices_sync": async (tx) => {
    const { syncCarrierNotices } = await import("./notices");
    return syncCarrierNotices(tx);
  },

  "document.extract": async (tx, job) => {
    const { extractDocumentJob } = await import("./documents");
    if (!job.organizationId) throw new Error("document.extract requires organization_id");
    const documentId = String(job.payload.documentId);
    const result = await extractDocumentJob(tx, job.organizationId, documentId);
    // Only a completed extraction is billable: a skipped or failed one cost the
    // tenant nothing they should pay for.
    if ("ok" in result && result.ok) {
      await recordUsage(tx, job.organizationId, "documents_extracted", 1, { documentId });
    }
    return result;
  },

  "compliance.scan": async (tx, job) => {
    const { scanOrganization } = await import("./compliance");
    if (!job.organizationId) throw new Error("compliance.scan requires organization_id");
    return scanOrganization(tx, job.organizationId);
  },

  "copilot.embed_knowledge": async (tx, job) => {
    if (!job.organizationId) throw new Error("copilot.embed_knowledge requires organization_id");
    const sourceType = job.payload.sourceType;
    const content = job.payload.content;
    if (
      sourceType !== "movement_note" &&
      sourceType !== "hold_resolution" &&
      sourceType !== "sop_document"
    ) {
      throw new Error("copilot.embed_knowledge has an invalid source_type");
    }
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("copilot.embed_knowledge requires content");
    }
    const sourceId = typeof job.payload.sourceId === "string" ? job.payload.sourceId : null;
    const { embedOrgKnowledge, invalidateOrgKnowledgeCache } = await import("./copilot");
    await embedOrgKnowledge(tx, job.organizationId, { sourceType, sourceId, content });
    // The org's corpus changed — retire its cached retrieval results.
    await invalidateOrgKnowledgeCache(job.organizationId);
    return { sourceType, sourceId };
  },
};

/**
 * Handlers that must NOT run inside the dispatcher's transaction because they
 * call a third-party API a bounded number of times per job and manage their own
 * short transactions around it. They get the pool, not a transaction, and their
 * job row is marked succeeded afterwards in a transaction of its own.
 */
type DetachedHandler = (db: DatabaseClient, job: Job) => Promise<Record<string, unknown> | void>;

export const detachedJobHandlers: Partial<Record<JobType, DetachedHandler>> = {
  "customs.decide": async (db, job) => {
    const orgId = job.organizationId;
    const movementId = String(job.payload.movementId);
    if (!orgId) throw new Error("customs.decide requires organization_id");
    const prepared = await withServiceRole(db, async (tx) => {
      const m = await requireMovement(tx, orgId, movementId);
      if (m.status !== "sent" && m.status !== "accepted" && m.status !== "held")
        return { m, skip: true as const };
      const full = await loadFull(tx, orgId, movementId);
      const org = await loadOrganization(tx, orgId);
      const gateway = await customsClientFor(tx, orgId, m.regime);
      return { m, full, org, client: gateway.client, config: gateway.config, skip: false as const };
    });
    if (prepared.skip) return { skipped: true, reason: `movement is ${prepared.m.status}` };
    const ref = String(job.payload.referenceNumber ?? prepared.m.customsReferenceNumber ?? "");
    const decision = await prepared.client.fetchDecision(
      ref,
      manifestFor(prepared.org, prepared.full),
      { currentStatus: prepared.m.status as "sent" | "accepted" | "held" },
    );
    return withServiceRole(db, async (tx) => {
      await logIntegrationEvent(tx, {
        orgId,
        movementId,
        provider: prepared.client.provider,
        direction: "inbound",
        operation: "decision",
        request: { referenceNumber: ref, currentStatus: prepared.m.status },
        response: { decision: decision.decision, message: decision.message, ...decision.raw },
        statusCode: 200,
        success: true,
        durationMs: 0,
        correlationId:
          typeof job.payload.correlationId === "string" ? job.payload.correlationId : null,
      });
      const current = await lockMovement(tx, orgId, movementId);
      if (current.status !== prepared.m.status) {
        return {
          skipped: true,
          reason: `movement moved to ${current.status} during the gateway call`,
        };
      }
      const updated = await applyCustomsDecision(tx, { orgId, userId: null }, current, {
        decision: decision.decision,
        referenceNumber: decision.referenceNumber,
        message: decision.message,
        simulated: prepared.client.environment === "sandbox",
        raw: decision.raw,
        events: decision.events,
        shipments: decision.shipments,
      });
      if (updated.status === "accepted" || updated.status === "held") {
        const delay = Math.max(1500, Number(prepared.config?.settings?.mockDelayMs ?? 4000));
        await enqueueJob(tx, {
          orgId,
          jobType: "customs.decide",
          payload: {
            movementId,
            referenceNumber: ref,
            correlationId: job.payload.correlationId ?? null,
          },
          runAt: new Date(Date.now() + (updated.status === "held" ? delay * 3 : delay)),
        });
      }
      return { decision: decision.decision, status: updated.status };
    });
  },
  /**
   * Gateway mode (0023): ask the gateway where the filing stands and apply
   * it. Re-enqueues itself every POLL_INTERVAL_MS until the decision is
   * terminal or 48 h have passed. Detached (ISSUE-005): the gateway call must
   * not hold a pooled connection.
   */
  "customs.poll_status": async (db, job) => {
    const orgId = job.organizationId;
    if (!orgId) throw new Error("customs.poll_status requires organization_id");
    const payload = {
      movementId: String(job.payload.movementId),
      referenceNumber:
        typeof job.payload.referenceNumber === "string" ? job.payload.referenceNumber : null,
      startedAt: typeof job.payload.startedAt === "string" ? job.payload.startedAt : null,
      correlationId:
        typeof job.payload.correlationId === "string" ? job.payload.correlationId : null,
    };
    const result = await pollCustomsStatus(db, orgId, payload);
    if (result.again) {
      await withServiceRole(db, (tx) =>
        enqueueJob(tx, {
          orgId,
          jobType: "customs.poll_status",
          payload: { ...job.payload, startedAt: payload.startedAt ?? new Date().toISOString() },
          runAt: new Date(Date.now() + POLL_INTERVAL_MS),
          maxAttempts: 5,
        }),
      );
    }
    return result;
  },
  /**
   * Push metered usage to Stripe. Queue-wide (organization_id is null): the
   * body lives in services/usage.ts so it can be exercised directly by
   * jobs.integration.test.ts.
   *
   * Detached because one run is up to 500 sequential Stripe calls — a
   * transaction held across those would pin a pooled connection for minutes.
   */
  "billing.report_usage": (db) => reportPendingUsage(db),
};

export interface ProcessResult {
  claimed: number;
  succeeded: number;
  failed: number;
  results: Array<{ id: number; jobType: string; ok: boolean; error?: string; result?: unknown }>;
}

/**
 * How many jobs one organization may have running at once. Keeps a tenant with
 * a large AI backlog from starving every other tenant's queue.
 */
function jobOrgCap(): number {
  const configured = Number(process.env.CORRIDOR_JOB_ORG_CAP);
  return Number.isInteger(configured) && configured > 0 ? configured : 2;
}

/**
 * How long a claimed job may stay `running` before another worker may take it
 * over. A worker that dies mid-job would otherwise hold one of its
 * organization's cap slots forever (see claim_jobs, migration 0013). Must
 * comfortably exceed the longest handler run — the cron route's maxDuration is
 * 300s, so the default is double that.
 */
function jobLeaseSeconds(): number {
  const configured = Number(process.env.CORRIDOR_JOB_LEASE_SECONDS);
  return Number.isInteger(configured) && configured > 0 ? configured : 600;
}

/**
 * Claim and run due jobs. Safe to call concurrently from multiple workers.
 * `organizationId` narrows the claim to one tenant (0041) — the manual
 * `integrations.jobs.runNow` path; the cron and request-tail workers omit it.
 */
export async function processDueJobs(
  db: DatabaseClient,
  opts: { limit?: number; worker?: string; organizationId?: string } = {},
): Promise<ProcessResult> {
  const limit = opts.limit ?? 10;
  const worker = opts.worker ?? `worker-${process.pid}`;
  const orgCap = jobOrgCap();
  const lease = jobLeaseSeconds();
  const organizationId = opts.organizationId ?? null;
  const claimed = await withServiceRole(db, (tx) =>
    tx.execute<Job>(
      sql`select * from public.claim_jobs(${limit}, ${worker}, ${orgCap}, ${lease}, ${organizationId}::uuid)`,
    ),
  );
  const out: ProcessResult = { claimed: claimed.length, succeeded: 0, failed: 0, results: [] };

  for (const raw of claimed) {
    // execute() returns snake_case columns; normalise the ones we use.
    const job = normalise(raw);
    const handler = jobHandlers[job.jobType as JobType];
    const detached = detachedJobHandlers[job.jobType as JobType];
    try {
      if (!handler && !detached) throw new Error(`no handler for job type ${job.jobType}`);
      const markSucceeded = (tx: RlsTransaction) =>
        tx
          .update(backgroundJobs)
          .set({
            status: "succeeded",
            finishedAt: new Date(),
            lastError: null,
            lockedAt: null,
            lockedBy: null,
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(eq(backgroundJobs.id, job.id));
      let result: Record<string, unknown> | void;
      if (detached) {
        // No transaction is open while the handler runs; the job row is only
        // stamped once it has returned, so a crash mid-flight retries the job.
        result = await detached(db, job);
        await withServiceRole(db, markSucceeded);
      } else {
        result = await withServiceRole(db, async (tx) => {
          const r = await handler!(tx, job);
          await markSucceeded(tx);
          return r;
        });
      }
      out.succeeded++;
      out.results.push({ id: job.id, jobType: job.jobType, ok: true, result: result ?? null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const retry = job.attempts < job.maxAttempts;
      await withServiceRole(db, (tx) =>
        tx
          .update(backgroundJobs)
          .set({
            status: retry ? "pending" : "failed",
            lastError: message,
            finishedAt: retry ? null : new Date(),
            // exponential backoff: 5s, 25s, 125s…
            runAt: retry ? new Date(Date.now() + 5000 * Math.pow(5, job.attempts - 1)) : job.runAt,
            lockedAt: null,
            lockedBy: null,
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(eq(backgroundJobs.id, job.id)),
      );
      out.failed++;
      out.results.push({ id: job.id, jobType: job.jobType, ok: false, error: message });
    }
  }
  return out;
}

function normalise(r: Record<string, unknown>): Job {
  return {
    id: Number(r.id),
    organizationId: (r.organization_id as string | null) ?? null,
    jobType: String(r.job_type),
    payload: (r.payload as Record<string, unknown>) ?? {},
    status: r.status as Job["status"],
    runAt: new Date(r.run_at as string),
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    lastError: (r.last_error as string | null) ?? null,
    lockedAt: r.locked_at ? new Date(r.locked_at as string) : null,
    lockedBy: (r.locked_by as string | null) ?? null,
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
    leaseToken: (r.lease_token as string | null) ?? null,
    leaseExpiresAt: r.lease_expires_at ? new Date(r.lease_expires_at as string) : null,
    createdAt: new Date(r.created_at as string),
    startedAt: r.started_at ? new Date(r.started_at as string) : null,
    finishedAt: r.finished_at ? new Date(r.finished_at as string) : null,
  };
}

/** True when any job is due now — cheap check used by the request-tail worker. */
export async function hasDueJobs(db: DatabaseClient): Promise<boolean> {
  const rows = await withServiceRole(db, (tx) =>
    tx
      .select({ id: backgroundJobs.id })
      .from(backgroundJobs)
      .where(and(eq(backgroundJobs.status, "pending"), sql`${backgroundJobs.runAt} <= now()`))
      .limit(1),
  );
  return rows.length > 0;
}

/** Earliest pending run_at (ms from now), or null. */
export async function nextJobDueInMs(db: DatabaseClient): Promise<number | null> {
  const rows = await withServiceRole(db, (tx) =>
    tx
      .select({ runAt: backgroundJobs.runAt })
      .from(backgroundJobs)
      .where(inArray(backgroundJobs.status, ["pending"]))
      .orderBy(backgroundJobs.runAt)
      .limit(1),
  );
  const next = rows[0]?.runAt;
  return next ? Math.max(0, next.getTime() - Date.now()) : null;
}

export { movements };
