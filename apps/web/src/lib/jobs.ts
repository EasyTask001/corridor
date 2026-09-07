import "server-only";
import { after } from "next/server";
import { getDb } from "@corridor/db";
import { hasDueJobs, nextJobDueInMs, processDueJobs } from "@corridor/api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Request-tail worker. Runs after the response is sent (Next `after()`), so
 * it never adds latency to the request itself.
 *
 *  - `drainDueJobs()`  — process anything already due. Cheap; called on every
 *    tRPC request, so the in-flight polling from the movement page itself
 *    guarantees a decision is applied within one poll interval of its run_at.
 *  - `scheduleJobTail()` — after a mutation, keep a worker alive for up to
 *    `budgetMs`, sleeping until each upcoming job is due. Gives sub-second
 *    latency for the first customs decision without a resident worker.
 *
 * Vercel Cron (`/api/jobs/process`, every minute) remains the safety net.
 * `claim_jobs` uses FOR UPDATE SKIP LOCKED, so overlapping tails are safe.
 */
export function drainDueJobs() {
  after(async () => {
    try {
      const db = getDb();
      if (await hasDueJobs(db)) await processDueJobs(db, { limit: 10, worker: "request" });
    } catch (e) {
      console.error("[jobs] drain failed", e);
    }
  });
}

export function scheduleJobTail(budgetMs = 25_000) {
  after(async () => {
    const db = getDb();
    const deadline = Date.now() + budgetMs;
    try {
      for (let i = 0; i < 6; i++) {
        const dueIn = await nextJobDueInMs(db);
        if (dueIn === null) return;
        const remaining = deadline - Date.now();
        if (dueIn > remaining) return;
        if (dueIn > 0) await sleep(dueIn + 50);
        await processDueJobs(db, { limit: 10, worker: "request-tail" });
      }
    } catch (e) {
      console.error("[jobs] tail failed", e);
    }
  });
}
