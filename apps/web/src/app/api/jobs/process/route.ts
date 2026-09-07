import { and, getDb, lt, notInArray, schema, sql, withServiceRole } from "@corridor/db";
import { processDueJobs } from "@corridor/api";
import { cronAuthFailure } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Background job worker. Triggered by Vercel Cron every minute (vercel.json)
 * and by the request-tail worker (lib/jobs.ts) for low latency.
 * Claims with FOR UPDATE SKIP LOCKED, so overlapping invocations are safe.
 *
 * Also sweeps orphaned uploads: a source_documents row left in `uploaded`
 * (browser closed before finalizeUpload) gets an extraction job queued; if
 * the object never reached Storage the job marks it `failed` for the user.
 */
export async function GET(req: Request) {
  const denied = cronAuthFailure(req);
  if (denied) return denied;

  const db = getDb();
  const swept = await sweepStaleUploads(db);
  const result = await processDueJobs(db, { limit: 25, worker: "cron" });
  return Response.json({ ok: true, swept, ...result });
}

async function sweepStaleUploads(db: ReturnType<typeof getDb>) {
  const { sourceDocuments, backgroundJobs } = schema;
  return withServiceRole(db, async (tx) => {
    const stale = await tx
      .select({ id: sourceDocuments.id, organizationId: sourceDocuments.organizationId })
      .from(sourceDocuments)
      .where(
        and(
          sql`${sourceDocuments.uploadStatus} = 'uploaded'`,
          lt(sourceDocuments.createdAt, new Date(Date.now() - 2 * 60_000)),
          notInArray(
            sourceDocuments.id,
            tx
              .select({ id: sql<string>`(${backgroundJobs.payload} ->> 'documentId')::uuid` })
              .from(backgroundJobs)
              .where(
                and(
                  sql`${backgroundJobs.jobType} = 'document.extract'`,
                  sql`${backgroundJobs.status} in ('pending','running')`,
                ),
              ),
          ),
        ),
      )
      .limit(50);
    if (stale.length === 0) return 0;
    await tx.insert(backgroundJobs).values(
      stale.map((d) => ({
        organizationId: d.organizationId,
        jobType: "document.extract",
        payload: { documentId: d.id, sweep: true },
        maxAttempts: 1,
      })),
    );
    return stale.length;
  });
}
