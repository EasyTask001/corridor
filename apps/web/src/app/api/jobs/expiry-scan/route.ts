import { getDb, schema, withServiceRole } from "@corridor/db";
import { enqueueJob, scanOrganization } from "@corridor/api";
import { cronAuthFailure } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Nightly document-expiry scan across every organization, plus the daily
 * hand-off of metered usage to Stripe.
 * Triggered by Vercel Cron (see vercel.json); authenticated with CRON_SECRET.
 * Runs under the service role and filters by organization_id per org.
 */
export async function GET(req: Request) {
  const denied = cronAuthFailure(req);
  if (denied) return denied;

  const db = getDb();
  const orgs = await db.select({ id: schema.organizations.id }).from(schema.organizations);
  const results: Record<string, Awaited<ReturnType<typeof scanOrganization>>> = {};

  for (const org of orgs) {
    results[org.id] = await withServiceRole(db, (tx) => scanOrganization(tx, org.id));
  }

  // Queue-wide, so no organization_id. The /api/jobs/process worker picks it
  // up on its next minute and settles every org's unreported usage.
  const usageJob = await withServiceRole(db, (tx) =>
    enqueueJob(tx, { orgId: null, jobType: "billing.report_usage", payload: {} }),
  );

  return Response.json({
    ok: true,
    organizations: orgs.length,
    results,
    usageReportJobId: usageJob.id,
  });
}
