import { getDb, withServiceRole } from "@corridor/db";
import { enqueueJob, processDueJobs } from "@corridor/api";
import { cronAuthFailure } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Every minute (vercel.json): drain BorderConnect's shared inbox — durably
 * store every message, then route and apply whatever is unprocessed
 * (services/borderconnect.ts). Queued as a `customs.borderconnect_drain` job
 * (queue-wide, no organization — `background_jobs_insert` refuses this job
 * type from any session, migration 0047) so a failed drain is retried by the
 * worker like any other job, then run right away.
 */
export async function GET(req: Request) {
  const denied = cronAuthFailure(req);
  if (denied) return denied;

  const db = getDb();
  const job = await withServiceRole(db, (tx) =>
    enqueueJob(tx, {
      orgId: null,
      jobType: "customs.borderconnect_drain",
      payload: {},
      idempotencyKey: `bc-drain:${new Date().toISOString().slice(0, 16)}`,
      maxAttempts: 2,
    }),
  );
  const result = await processDueJobs(db, { limit: 5, worker: "cron-borderconnect" });
  return Response.json({ ok: true, jobId: job.id, ...result });
}
