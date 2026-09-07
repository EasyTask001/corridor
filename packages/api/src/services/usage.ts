/**
 * Usage metering. Every billable event the app performs lands in
 * `usage_records` through the membership-checked `record_usage()` definer, and
 * the billing page reads the current period back out of it.
 *
 * Metering is deliberately best-effort at the call site: a meter write must
 * never be the reason a customs transmission or a copilot answer fails. The
 * writes that share the caller's transaction (submit, suggestions) roll back
 * with it, which is the behaviour we want — an action that did not happen is
 * not billed.
 */
import {
  and,
  asc,
  eq,
  isNull,
  lt,
  schema,
  sql,
  withServiceRole,
  type DatabaseClient,
  type RlsTransaction,
} from "@corridor/db";
import { USAGE_METRICS, type UsageMetric } from "@corridor/domain";
import {
  planUsageFor,
  reportUsage,
  type PlanUsage,
  type UsageMeterRecord,
} from "@corridor/integrations";
import type { SubscriptionPlan } from "@corridor/domain";

const { organizations, usageRecords } = schema;

export type UsageTotals = Record<UsageMetric, number>;

const zeroTotals = (): UsageTotals =>
  Object.fromEntries(USAGE_METRICS.map((m) => [m, 0])) as UsageTotals;

/**
 * First day of the calendar month (UTC) `when` falls in, as `YYYY-MM-DD` —
 * the same value `record_usage()` stamps into `period_start`.
 */
export function periodStartOf(when: Date = new Date()): string {
  const y = when.getUTCFullYear();
  const m = String(when.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/**
 * Record one metered event. Goes through the SECURITY DEFINER so it works from
 * both a caller's RLS transaction and the service-role worker.
 */
export async function recordUsage(
  tx: RlsTransaction,
  orgId: string,
  metric: UsageMetric,
  quantity = 1,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await tx.execute(sql`
    select public.record_usage(
      ${orgId}::uuid, ${metric}, ${quantity}::int, ${JSON.stringify(metadata)}::jsonb
    )
  `);
}

/** Per-metric totals for one billing period. Missing metrics read as 0. */
export async function usageTotals(
  tx: RlsTransaction,
  orgId: string,
  periodStart: string = periodStartOf(),
): Promise<UsageTotals> {
  const rows = await tx
    .select({
      metric: usageRecords.metric,
      quantity: sql<number>`coalesce(sum(${usageRecords.quantity}), 0)::int`,
    })
    .from(usageRecords)
    .where(and(eq(usageRecords.organizationId, orgId), eq(usageRecords.periodStart, periodStart)))
    .groupBy(usageRecords.metric);
  const totals = zeroTotals();
  for (const row of rows) totals[row.metric] = Number(row.quantity);
  return totals;
}

export interface MetricOverage {
  used: number;
  /** null = unlimited, so never any overage. */
  included: number | null;
  billable: number;
  unitUsd: number;
  amountUsd: number;
}

export interface UsageProjection {
  periodStart: string;
  totals: UsageTotals;
  documents: MetricOverage;
  copilotMessages: MetricOverage;
  projectedOverageUsd: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function overageFor(used: number, included: number | null, unitUsd: number): MetricOverage {
  const billable = included === null ? 0 : Math.max(0, used - included);
  return { used, included, billable, unitUsd, amountUsd: round2(billable * unitUsd) };
}

/**
 * What the period costs beyond the plan: max(0, used − included) × unit price
 * per metered metric. An unlimited (enterprise) allowance is never in overage.
 * `movements_transmitted` and `ai_suggestions` are metered for reporting only
 * and carry no price.
 */
export function projectUsage(
  usage: PlanUsage,
  totals: UsageTotals,
  periodStart: string = periodStartOf(),
): UsageProjection {
  const documents = overageFor(
    totals.documents_extracted,
    usage.includedDocuments,
    usage.overageUsdPerDocument,
  );
  const copilotMessages = overageFor(
    totals.copilot_messages,
    usage.includedCopilotMessages,
    usage.overageUsdPerMessage,
  );
  return {
    periodStart,
    totals,
    documents,
    copilotMessages,
    projectedOverageUsd: round2(documents.amountUsd + copilotMessages.amountUsd),
  };
}

/** The billing page's usage block: this period's meter against the plan. */
export async function usageForPlan(
  tx: RlsTransaction,
  orgId: string,
  plan: SubscriptionPlan,
  periodStart: string = periodStartOf(),
): Promise<UsageProjection> {
  return projectUsage(planUsageFor(plan), await usageTotals(tx, orgId, periodStart), periodStart);
}

/**
 * How long a metered event settles before it is reported. Long enough that the
 * transaction that wrote it is committed and any same-request retry has played
 * out, short enough to stay well inside Stripe's meter-event window.
 */
const USAGE_SETTLE_MS = 60 * 60 * 1000;

/** How many usage records one reporter run settles. */
const USAGE_REPORT_BATCH = 500;

/**
 * A type alias, not an interface, so it satisfies the job dispatcher's
 * `Record<string, unknown>` handler return type (interfaces get no implicit
 * index signature).
 */
export type UsageReportResult = {
  reported: number;
  organizations: number;
  failures: Array<{ organizationId: string; error: string }>;
};

/**
 * Hand every settled, unreported meter event to Stripe and stamp the rows —
 * the body of the `billing.report_usage` job (services/jobs.ts).
 *
 * Runs queue-wide under the service role, so it reports every organization in
 * one pass, batched per org: a Stripe failure for one tenant is caught and
 * leaves that tenant's rows unreported for the next run rather than stranding
 * everybody else's. `reported_at` is the idempotency marker on our side; the
 * record id is what Stripe deduplicates on.
 *
 * `report` is injectable so tests can drive the failure path without a Stripe
 * key or a network stub; production always uses the real reporter, which
 * itself degrades to synthetic ids when no key is configured.
 *
 * ## Why this takes a `db`, not a transaction
 *
 * A batch is up to 500 records and Stripe wants one meter event per record, so
 * a run can be hundreds of sequential HTTP calls. Holding a Postgres
 * transaction — and therefore a pooled connection — open across all of them is
 * the same mistake `billing.checkout` and the SSO `configure` path already
 * avoid: it pins a connection for the whole round-trip and keeps the rows'
 * snapshot alive for minutes. So the run is three phases:
 *
 *   1. one short transaction picks the batch,
 *   2. Stripe is called with **no transaction open**,
 *   3. one short transaction per org stamps what actually landed.
 *
 * The retry story is unchanged: `reportUsage` derives a deterministic
 * `identifier` from the record id, so a crash between (2) and (3) leaves the
 * rows unstamped and the next run re-sends events Stripe deduplicates away.
 */
export async function reportPendingUsage(
  db: DatabaseClient,
  report: (
    records: UsageMeterRecord[],
  ) => Promise<Array<{ id: number; eventId: string }>> = reportUsage,
  now: Date = new Date(),
): Promise<UsageReportResult> {
  const cutoff = new Date(now.getTime() - USAGE_SETTLE_MS);
  const pending = await withServiceRole(db, (tx) =>
    tx
      .select({
        id: usageRecords.id,
        organizationId: usageRecords.organizationId,
        metric: usageRecords.metric,
        quantity: usageRecords.quantity,
        occurredAt: usageRecords.occurredAt,
        stripeCustomerId: organizations.stripeCustomerId,
      })
      .from(usageRecords)
      .innerJoin(organizations, eq(organizations.id, usageRecords.organizationId))
      .where(and(isNull(usageRecords.reportedAt), lt(usageRecords.occurredAt, cutoff)))
      .orderBy(asc(usageRecords.occurredAt), asc(usageRecords.id))
      .limit(USAGE_REPORT_BATCH),
  );
  if (pending.length === 0) return { reported: 0, organizations: 0, failures: [] };

  const byOrg = new Map<string, UsageMeterRecord[]>();
  for (const row of pending) {
    const list = byOrg.get(row.organizationId) ?? [];
    list.push(row);
    byOrg.set(row.organizationId, list);
  }

  let reported = 0;
  const failures: UsageReportResult["failures"] = [];
  for (const [organizationId, records] of byOrg) {
    try {
      const results = await report(records);
      if (results.length === 0) continue;
      const stamped = await withServiceRole(db, async (tx) => {
        let n = 0;
        for (const result of results) {
          await tx
            .update(usageRecords)
            .set({ reportedAt: new Date(), stripeMeterEventId: result.eventId })
            .where(eq(usageRecords.id, result.id));
          n++;
        }
        return n;
      });
      // Only counted once the stamping transaction has committed: a rolled-back
      // write leaves the rows for the next run, and must not be reported as done.
      reported += stamped;
    } catch (e) {
      failures.push({ organizationId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { reported, organizations: byOrg.size, failures };
}
