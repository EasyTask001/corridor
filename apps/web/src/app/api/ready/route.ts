import { getDb } from "@corridor/db";
import { collectReadiness } from "@corridor/api";
import { readinessAuthFailure } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dependency and business-worker readiness. `/api/health` remains pure
 * liveness. This route is reachable by anyone — it is what a load balancer
 * or uptime check calls — so the detailed body (queue depth, provider
 * activity age, missing production variable *names*) is only ever returned
 * to a caller presenting `Authorization: Bearer $READINESS_SECRET`; every
 * other caller gets the same `{ ok }` an unauthenticated health probe needs,
 * with the same 200/503 status the detailed check would have returned.
 */
export async function GET(req: Request) {
  const detailed = readinessAuthFailure(req) === null;
  try {
    const result = await collectReadiness(getDb());
    const body = detailed ? result : { ok: result.ok };
    return Response.json(body, {
      status: result.ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      detailed
        ? {
            ok: false,
            service: "corridor-web",
            at: new Date().toISOString(),
            checks: { postgres: { ok: false } },
          }
        : { ok: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
