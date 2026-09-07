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
import type { ManifestPayload } from "@corridor/integrations";
import { customsClientFor, logIntegrationEvent, manifestFor } from "./customs";
import { applyCustomsDecision, loadFull, loadOrganization, requireMovement } from "./movements";

const { backgroundJobs, movements } = schema;

export type JobType =
  "customs.decide" | "compliance.scan" | "document.extract" | "copilot.embed_knowledge";

export async function enqueueJob(
  tx: RlsTransaction,
  job: {
    orgId: string | null;
    jobType: JobType;
    payload: Record<string, unknown>;
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
      runAt: job.runAt ?? new Date(),
      maxAttempts: job.maxAttempts ?? 3,
    })
    .returning({ id: backgroundJobs.id, runAt: backgroundJobs.runAt });
  return row!;
}

type Job = typeof backgroundJobs.$inferSelect;
type Handler = (tx: RlsTransaction, job: Job) => Promise<Record<string, unknown> | void>;

const handlers: Record<JobType, Handler> = {
  /**
   * Ask the customs gateway for its decision on a transmitted manifest and
   * apply it. Chains the next decision (accepted → released/held → released)
   * with a further delay so the timeline unfolds like a real crossing.
   */
  "customs.decide": async (tx, job) => {
    const orgId = job.organizationId;
    const movementId = String(job.payload.movementId);
    if (!orgId) throw new Error("customs.decide requires organization_id");
    const m = await requireMovement(tx, orgId, movementId);
    if (m.status !== "sent" && m.status !== "accepted" && m.status !== "held") {
      return { skipped: true, reason: `movement is ${m.status}` };
    }
    const full = await loadFull(tx, orgId, movementId);
    const org = await loadOrganization(tx, orgId);
    const { client } = await customsClientFor(tx, orgId, m.regime);
    const manifest: ManifestPayload = manifestFor(org, full);
    const ref = String(job.payload.referenceNumber ?? m.customsReferenceNumber ?? "");
    const started = Date.now();
    const decision = await client.fetchDecision(ref, manifest, { currentStatus: m.status });
    await logIntegrationEvent(tx, {
      orgId,
      movementId,
      provider: client.provider,
      direction: "inbound",
      operation: "decision",
      request: { referenceNumber: ref, currentStatus: m.status },
      response: { decision: decision.decision, message: decision.message, ...decision.raw },
      statusCode: 200,
      success: true,
      durationMs: Date.now() - started,
      correlationId:
        typeof job.payload.correlationId === "string" ? job.payload.correlationId : null,
    });
    const updated = await applyCustomsDecision(tx, { orgId, userId: null }, m, {
      decision: decision.decision,
      referenceNumber: decision.referenceNumber,
      message: decision.message,
      simulated: client.environment === "sandbox",
      raw: decision.raw,
    });
    // Chain the next stage of the crossing.
    if (updated.status === "accepted" || updated.status === "held") {
      const delay = Math.max(
        1500,
        Number((await customsClientFor(tx, orgId, m.regime)).config?.settings?.mockDelayMs ?? 4000),
      );
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
  },

  "document.extract": async (tx, job) => {
    const { extractDocumentJob } = await import("./documents");
    if (!job.organizationId) throw new Error("document.extract requires organization_id");
    return extractDocumentJob(tx, job.organizationId, String(job.payload.documentId));
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
    const { embedOrgKnowledge } = await import("./copilot");
    await embedOrgKnowledge(tx, job.organizationId, { sourceType, sourceId, content });
    return { sourceType, sourceId };
  },
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

/** Claim and run due jobs. Safe to call concurrently from multiple workers. */
export async function processDueJobs(
  db: DatabaseClient,
  opts: { limit?: number; worker?: string } = {},
): Promise<ProcessResult> {
  const limit = opts.limit ?? 10;
  const worker = opts.worker ?? `worker-${process.pid}`;
  const orgCap = jobOrgCap();
  const claimed = await withServiceRole(db, (tx) =>
    tx.execute<Job>(sql`select * from public.claim_jobs(${limit}, ${worker}, ${orgCap})`),
  );
  const out: ProcessResult = { claimed: claimed.length, succeeded: 0, failed: 0, results: [] };

  for (const raw of claimed) {
    // execute() returns snake_case columns; normalise the ones we use.
    const job = normalise(raw as unknown as Record<string, unknown>);
    const handler = handlers[job.jobType as JobType];
    try {
      if (!handler) throw new Error(`no handler for job type ${job.jobType}`);
      const result = await withServiceRole(db, async (tx) => {
        const r = await handler(tx, job);
        await tx
          .update(backgroundJobs)
          .set({ status: "succeeded", finishedAt: new Date(), lastError: null })
          .where(eq(backgroundJobs.id, job.id));
        return r;
      });
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
