import { getDb } from "@corridor/db";
import { collectReadiness } from "@corridor/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Dependency and business-worker readiness. `/api/health` remains pure liveness. */
export async function GET() {
  try {
    const result = await collectReadiness(getDb());
    return Response.json(result, {
      status: result.ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      {
        ok: false,
        service: "corridor-web",
        at: new Date().toISOString(),
        checks: { postgres: { ok: false } },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
