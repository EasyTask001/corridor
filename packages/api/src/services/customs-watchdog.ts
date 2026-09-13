import { sql, withServiceRole, type DatabaseClient } from "@corridor/db";
import { corridorMetrics } from "@corridor/observability";

export type WatchdogSeverity = "critical" | "error" | "warning";

export interface CustomsWatchdogSnapshot {
  staleSubmissions: number;
  overdueDrainJobs: number;
  failedDrainJobs: number;
  unprocessedInbox: number;
  repeatedlyFailingInbox: number;
  unknownRoutes: number;
  ambiguousRoutes: number;
  providerRequests: number;
  providerFailures: number;
  acknowledgementP95Ms: number;
  queueDepth: number;
  oldestJobAgeMs: number;
}

export interface WatchdogCondition {
  code:
    | "stale_submission"
    | "drain_job_unhealthy"
    | "inbox_processing_unhealthy"
    | "tenant_routing_unhealthy"
    | "provider_failure_elevated"
    | "acknowledgement_latency_elevated";
  title: string;
  severity: WatchdogSeverity;
  count: number;
  details: Record<string, number>;
}

export function buildWatchdogConditions(snapshot: CustomsWatchdogSnapshot): WatchdogCondition[] {
  const out: WatchdogCondition[] = [];
  if (snapshot.staleSubmissions > 0) {
    out.push({
      code: "stale_submission",
      title: "Customs submissions unchanged for more than five minutes",
      severity: "critical",
      count: snapshot.staleSubmissions,
      details: { staleSubmissions: snapshot.staleSubmissions },
    });
  }
  const drainJobs = snapshot.overdueDrainJobs + snapshot.failedDrainJobs;
  if (drainJobs > 0) {
    out.push({
      code: "drain_job_unhealthy",
      title: "BorderConnect drain jobs are overdue or failed",
      severity: "critical",
      count: drainJobs,
      details: {
        overdueDrainJobs: snapshot.overdueDrainJobs,
        failedDrainJobs: snapshot.failedDrainJobs,
      },
    });
  }
  const inboxFailures = snapshot.unprocessedInbox + snapshot.repeatedlyFailingInbox;
  if (inboxFailures > 0) {
    out.push({
      code: "inbox_processing_unhealthy",
      title: "BorderConnect inbox messages are unprocessed or repeatedly failing",
      severity: "error",
      count: inboxFailures,
      details: {
        unprocessedInbox: snapshot.unprocessedInbox,
        repeatedlyFailingInbox: snapshot.repeatedlyFailingInbox,
      },
    });
  }
  const routingFailures = snapshot.unknownRoutes + snapshot.ambiguousRoutes;
  if (routingFailures > 0) {
    out.push({
      code: "tenant_routing_unhealthy",
      title: "BorderConnect messages have unknown or ambiguous tenant routing",
      severity: "critical",
      count: routingFailures,
      details: {
        unknownRoutes: snapshot.unknownRoutes,
        ambiguousRoutes: snapshot.ambiguousRoutes,
      },
    });
  }
  const failureRate = snapshot.providerRequests
    ? snapshot.providerFailures / snapshot.providerRequests
    : 0;
  if (snapshot.providerFailures >= 3 && failureRate >= 0.2) {
    out.push({
      code: "provider_failure_elevated",
      title: "Customs provider request failures are elevated",
      severity: failureRate >= 0.5 ? "critical" : "error",
      count: snapshot.providerFailures,
      details: {
        requests: snapshot.providerRequests,
        failures: snapshot.providerFailures,
        failureRate: Math.round(failureRate * 1000) / 1000,
      },
    });
  }
  if (snapshot.acknowledgementP95Ms >= 120_000) {
    out.push({
      code: "acknowledgement_latency_elevated",
      title: "Customs submission acknowledgement latency is elevated",
      severity: "error",
      count: 1,
      details: { acknowledgementP95Ms: snapshot.acknowledgementP95Ms },
    });
  }
  return out;
}

interface WatchdogDbRow extends Record<string, unknown> {
  stale_submissions: number;
  overdue_drain_jobs: number;
  failed_drain_jobs: number;
  unprocessed_inbox: number;
  repeatedly_failing_inbox: number;
  unknown_routes: number;
  ambiguous_routes: number;
  provider_requests: number;
  provider_failures: number;
  acknowledgement_p95_ms: number | null;
  queue_depth: number;
  oldest_job_age_ms: number;
}

export async function collectCustomsWatchdog(db: DatabaseClient): Promise<{
  snapshot: CustomsWatchdogSnapshot;
  conditions: WatchdogCondition[];
}> {
  const rows = await withServiceRole(db, (tx) =>
    tx.execute<WatchdogDbRow>(sql`
      select
        (select count(*)::int from public.customs_submissions
          where status in ('sent', 'acknowledged')
            and updated_at < now() - interval '5 minutes') as stale_submissions,
        (select count(*)::int from public.background_jobs
          where job_type = 'customs.borderconnect_drain' and status = 'pending'
            and run_at < now() - interval '1 minute') as overdue_drain_jobs,
        (select count(*)::int from public.background_jobs
          where job_type = 'customs.borderconnect_drain' and status = 'failed'
            and created_at > now() - interval '1 hour') as failed_drain_jobs,
        (select count(*)::int from public.customs_inbox
          where processed_at is null and received_at < now() - interval '2 minutes') as unprocessed_inbox,
        (select count(*)::int from public.customs_inbox
          where received_at > now() - interval '1 hour'
            and processing_error ~ 'attempt=([2-9]|[1-9][0-9]+)') as repeatedly_failing_inbox,
        (select count(*)::int from public.customs_inbox
          where received_at > now() - interval '1 hour'
            and processing_error ilike 'unknown %') as unknown_routes,
        (select count(*)::int from public.customs_inbox
          where received_at > now() - interval '1 hour'
            and processing_error ilike 'ambiguous %') as ambiguous_routes,
        (select count(*)::int from public.integration_events
          where direction = 'outbound' and provider in ('cbp_ace', 'cbsa_aci')
            and created_at > now() - interval '15 minutes') as provider_requests,
        (select count(*)::int from public.integration_events
          where direction = 'outbound' and provider in ('cbp_ace', 'cbsa_aci')
            and success = false and created_at > now() - interval '15 minutes') as provider_failures,
        (select percentile_disc(0.95) within group (
            order by extract(epoch from (updated_at - created_at)) * 1000
          )::bigint from public.customs_submissions
          where status not in ('sent', 'failed') and created_at > now() - interval '1 hour') as acknowledgement_p95_ms,
        (select count(*)::int from public.background_jobs
          where status in ('pending', 'running')) as queue_depth,
        (select coalesce(extract(epoch from (now() - min(created_at))) * 1000, 0)::bigint
          from public.background_jobs where status in ('pending', 'running')) as oldest_job_age_ms
    `),
  );
  const row = rows[0];
  if (!row) throw new Error("customs watchdog query returned no row");
  const snapshot: CustomsWatchdogSnapshot = {
    staleSubmissions: Number(row.stale_submissions),
    overdueDrainJobs: Number(row.overdue_drain_jobs),
    failedDrainJobs: Number(row.failed_drain_jobs),
    unprocessedInbox: Number(row.unprocessed_inbox),
    repeatedlyFailingInbox: Number(row.repeatedly_failing_inbox),
    unknownRoutes: Number(row.unknown_routes),
    ambiguousRoutes: Number(row.ambiguous_routes),
    providerRequests: Number(row.provider_requests),
    providerFailures: Number(row.provider_failures),
    acknowledgementP95Ms: Number(row.acknowledgement_p95_ms ?? 0),
    queueDepth: Number(row.queue_depth),
    oldestJobAgeMs: Number(row.oldest_job_age_ms),
  };
  const conditions = buildWatchdogConditions(snapshot);
  corridorMetrics.jobQueue({ depth: snapshot.queueDepth, oldestAgeMs: snapshot.oldestJobAgeMs });
  for (const condition of conditions) {
    corridorMetrics.watchdogIssue({
      condition: condition.code,
      severity: condition.severity,
      count: condition.count,
    });
  }
  return { snapshot, conditions };
}
