import { timingSafeEqual } from "node:crypto";
import { getDb } from "@corridor/db";
import { processDueJobs } from "@corridor/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Background job worker. Triggered by Vercel Cron every minute (vercel.json)
 * and by the request-tail worker (lib/jobs.ts) for low latency.
 * Claims with FOR UPDATE SKIP LOCKED, so overlapping invocations are safe.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const authorized =
    (!!secret &&
      provided.length === secret.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(secret))) ||
    (!secret && process.env.NODE_ENV !== "production");
  if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });

  const result = await processDueJobs(getDb(), { limit: 25, worker: "cron" });
  return Response.json({ ok: true, ...result });
}
