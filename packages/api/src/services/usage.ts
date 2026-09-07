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
import { and, eq, schema, sql, type RlsTransaction } from "@corridor/db";
import { USAGE_METRICS, type UsageMetric } from "@corridor/domain";
import { planUsageFor, type PlanUsage } from "@corridor/integrations";
import type { SubscriptionPlan } from "@corridor/domain";

const { usageRecords } = schema;

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
