/**
 * Bulk document upload → extraction queue drain.
 *
 * Walks the real three-step upload the browser performs — reserve a row and a
 * signed URL (`documents.getUploadUrl`), PUT the bytes straight to Storage, then
 * queue extraction (`documents.finalizeUpload`) — and then watches the queue
 * empty.
 *
 * Threshold: **the queue drains UPLOADS documents within 5 minutes** (the plan's
 * number, default 100 uploads). "Drained" means no document this run created is
 * still `uploaded` or `processing`; `failed` counts as drained, because the
 * question is whether the worker kept up, not whether the extractor liked the
 * text. A separate threshold keeps the failure rate honest.
 *
 * Two things will make this fail for reasons that are not the queue:
 *
 *  1. **Rate limits.** `finalizeUpload` is an `aiProcedure` — the `ai` tier is
 *     counted *per organization* and starts at 5/min on the trial plan (×10
 *     locally, see `rateLimitMultiplier()`). 100 uploads into one org needs
 *     `CORRIDOR_RATELIMIT_MULTIPLIER=200` on the server, or several orgs.
 *  2. **No worker.** Jobs are drained by `/api/jobs/process` (Vercel Cron in
 *     production) and by the request-tail worker in `lib/jobs.ts`. Locally the
 *     tail worker runs on every tRPC POST, so the polling below keeps it alive;
 *     against a deployment, make sure the cron is on.
 *
 * The uploaded documents are deliberately **left behind** — a load run should be
 * inspectable afterwards. Delete them from Documents, or reset the database.
 *
 * Run:
 *   pnpm load:login
 *   CORRIDOR_RATELIMIT_MULTIPLIER=200 pnpm dev     # server side
 *   k6 run load/k6/bulk-upload.js
 *   UPLOADS=250 VUS=10 k6 run load/k6/bulk-upload.js
 *
 * Env: BASE_URL, ORGS, DISPATCHERS_PER_ORG, UPLOADS, VUS, DRAIN_TIMEOUT_S.
 */
import { check, fail, sleep } from "k6";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";
import {
  baseUrl,
  intEnv,
  loadSessions,
  selectSessions,
  trpcData,
  trpcMutation,
  trpcQuery,
} from "./lib.js";

const file = loadSessions();
const BASE = baseUrl(file);
const SESSIONS = selectSessions(
  file.sessions,
  intEnv("ORGS", 1),
  intEnv("DISPATCHERS_PER_ORG", 1),
);

const UPLOADS = intEnv("UPLOADS", 100);
const VUS = Math.min(intEnv("VUS", 10), UPLOADS);
/** The plan's bar: five minutes. */
const DRAIN_TIMEOUT_S = intEnv("DRAIN_TIMEOUT_S", 300);
const PAGE = 200; // documentListInput caps `limit` at 200.

const uploadDuration = new Trend("upload_round_trip", true);
const uploadsQueued = new Counter("uploads_queued");
const rateLimited = new Rate("rate_limited");
const drainSeconds = new Trend("queue_drain_seconds");
const drained = new Rate("queue_drained");
const extractionFailed = new Rate("extraction_failed");

export const options = {
  scenarios: {
    uploads: {
      executor: "shared-iterations",
      vus: VUS,
      iterations: UPLOADS,
      // Generous: the ceiling that matters is the drain, measured separately.
      maxDuration: "10m",
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    rate_limited: ["rate<0.01"],
    // The plan's bar, asserted on the measured drain.
    queue_drain_seconds: [`max<${DRAIN_TIMEOUT_S}`],
    queue_drained: ["rate==1"],
    extraction_failed: ["rate<0.05"],
  },
};

/**
 * The init context re-runs per VU, so a run id computed there would differ
 * between VUs. `setup()` runs once and its return value reaches every VU and
 * `teardown()`.
 */
export function setup() {
  return { runTag: `k6-${Date.now().toString(36)}` };
}

/** A plausible BOL — the mock extractor reads text, so give it something to read. */
function bolText(id) {
  return [
    `BILL OF LADING ${id}`,
    "SHIPPER: Pathfinder Logistics, 100 Bay St, Toronto ON",
    "CONSIGNEE: Northbound Freight, 4400 Michigan Ave, Detroit MI",
    "CARRIER SCAC: PFDR",
    `PRO NUMBER: ${id}`,
    "1  STEEL COILS  HS 7208.10  12 PCS  18400 KG  ORIGIN CA",
    "2  ALUMINIUM SHEET  HS 7606.11  4 PCS  2200 KG  ORIGIN CA",
    "TOTAL PIECES: 16   TOTAL WEIGHT: 20600 KG",
  ].join("\n");
}

export default function bulkUpload(data) {
  const session = SESSIONS[(__VU - 1) % SESSIONS.length];
  const id = `${data.runTag}-${__VU}-${__ITER}`;
  const body = bolText(id);
  const started = Date.now();

  const reserved = trpcMutation(BASE, session, "documents.getUploadUrl", {
    filename: `${id}.txt`,
    mimeType: "text/plain",
    sizeBytes: body.length,
    documentType: "bol",
  });
  rateLimited.add(reserved.status === 429);
  const reservation = trpcData(reserved);
  if (!check(reserved, { "getUploadUrl 200": () => reservation !== null })) return;

  // Straight to Storage — the signed URL is absolute and carries its own token,
  // so the file never passes through a Next.js function.
  const put = http.put(reservation.signedUrl, body, {
    headers: { "content-type": "text/plain" },
    tags: { trpc: "storage.put" },
  });
  if (!check(put, { "storage PUT 200": (r) => r.status === 200 })) return;

  const finalized = trpcMutation(BASE, session, "documents.finalizeUpload", {
    documentId: reservation.documentId,
  });
  rateLimited.add(finalized.status === 429);
  if (!check(finalized, { "finalizeUpload 200": () => trpcData(finalized) !== null })) return;

  uploadsQueued.add(1);
  uploadDuration.add(Date.now() - started);
}

/** Every distinct org in the roster, with one session that can read its documents. */
function readersByOrg() {
  const byOrg = new Map();
  for (const s of SESSIONS) if (!byOrg.has(s.orgId)) byOrg.set(s.orgId, s);
  return [...byOrg.values()];
}

/** This run's documents in one org, paging until the run tag stops appearing. */
function runDocuments(session, runTag) {
  const found = [];
  for (let offset = 0; offset < 2000; offset += PAGE) {
    const data = trpcData(trpcQuery(BASE, session, "documents.list", { limit: PAGE, offset }));
    if (!data) break;
    found.push(...data.rows.filter((r) => (r.originalFilename ?? "").startsWith(runTag)));
    if (data.rows.length < PAGE || offset + PAGE >= data.total) break;
  }
  return found;
}

/**
 * Poll until nothing from this run is still queued. The poll is a tRPC request,
 * which also keeps the local request-tail worker awake.
 */
export function teardown(data) {
  const readers = readersByOrg();
  const deadline = Date.now() + DRAIN_TIMEOUT_S * 1000;
  const started = Date.now();
  let pending = -1;
  let failedCount = 0;
  let total = 0;

  while (Date.now() < deadline) {
    const rows = [];
    for (const reader of readers) rows.push(...runDocuments(reader, data.runTag));
    total = rows.length;
    pending = rows.filter(
      (r) => r.uploadStatus === "uploaded" || r.uploadStatus === "processing",
    ).length;
    failedCount = rows.filter((r) => r.uploadStatus === "failed").length;
    if (total > 0 && pending === 0) break;
    sleep(5);
  }

  const elapsed = (Date.now() - started) / 1000;
  drainSeconds.add(elapsed);
  drained.add(total > 0 && pending === 0);
  if (total > 0) extractionFailed.add(failedCount / total);

  console.log(
    `queue drain: ${total - pending}/${total} settled in ${elapsed.toFixed(0)}s ` +
      `(bar ${DRAIN_TIMEOUT_S}s, ${failedCount} failed extraction)`,
  );
  if (total === 0) {
    fail(
      `no documents tagged ${data.runTag} were visible — did every upload get rate limited? ` +
        "See the header on CORRIDOR_RATELIMIT_MULTIPLIER.",
    );
  }
}
