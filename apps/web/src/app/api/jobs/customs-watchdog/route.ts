import * as Sentry from "@sentry/nextjs";
import { collectCustomsWatchdog } from "@corridor/api";
import { getDb } from "@corridor/db";
import { cronAuthFailure } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const denied = cronAuthFailure(req);
  if (denied) return denied;

  try {
    const { snapshot, conditions } = await collectCustomsWatchdog(getDb());
    for (const condition of conditions) {
      Sentry.captureMessage(condition.title, {
        level: condition.severity === "critical" ? "fatal" : condition.severity,
        fingerprint: ["customs-watchdog", condition.code],
        tags: {
          component: "customs-watchdog",
          condition: condition.code,
          severity: condition.severity,
        },
        extra: condition.details,
      });
    }
    if (conditions.length > 0) await Sentry.flush(2_000);
    return Response.json({
      ok: conditions.length === 0,
      observedAt: new Date().toISOString(),
      conditions,
      metrics: {
        queueDepth: snapshot.queueDepth,
        oldestJobAgeMs: snapshot.oldestJobAgeMs,
        providerRequests: snapshot.providerRequests,
        providerFailures: snapshot.providerFailures,
        acknowledgementP95Ms: snapshot.acknowledgementP95Ms,
      },
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { component: "customs-watchdog", condition: "watchdog_failed" },
    });
    await Sentry.flush(2_000);
    return Response.json({ ok: false, error: "Customs watchdog unavailable" }, { status: 503 });
  }
}
