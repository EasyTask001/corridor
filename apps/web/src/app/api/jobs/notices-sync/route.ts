import { getDb, withServiceRole } from "@corridor/db";
import { enqueueJob, processDueJobs } from "@corridor/api";
import { cronAuthFailure } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Hourly (vercel.json): pull CBP/CBSA service notices and tell every
 * organization with an enabled customs config. Queued as a
 * `customs.notices_sync` job (queue-wide, no organization) so a failed pull
 * is retried by the worker like any other job, then run right away.
 */
export async function GET(req: Request) {
  const denied = cronAuthFailure(req);
  if (denied) return denied;

  const db = getDb();
  const job = await withServiceRole(db, (tx) =>
    enqueueJob(tx, { orgId: null, jobType: "customs.notices_sync", payload: {}, maxAttempts: 2 }),
  );
  const result = await processDueJobs(db, { limit: 5, worker: "cron-notices" });
  return Response.json({ ok: true, jobId: job.id, ...result });
}
