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
 * worker like any other job, then run right away. `jobId` (0048) claims
 * exactly this job — an unscoped claim would also execute up to `limit`
 * other tenants' unrelated due jobs under this cron's worker name.
 */
export async function GET(req: Request) {
  const denied = cronAuthFailure(req);
  if (denied) return denied;

  const db = getDb();
  const environment =
    process.env.VERCEL_ENV === "production" || process.env.CORRIDOR_ENV === "production"
      ? "production"
      : "sandbox";
  const job = await withServiceRole(db, (tx) =>
    enqueueJob(tx, {
      orgId: null,
      jobType: "customs.borderconnect_drain",
      payload: { environment },
      idempotencyKey: `bc-drain:${new Date().toISOString().slice(0, 16)}`,
      maxAttempts: 2,
    }),
  );
  const result = await processDueJobs(db, { jobId: job.id, limit: 1, worker: "cron-borderconnect" });
  return Response.json({ ok: true, jobId: job.id, ...result });
}
