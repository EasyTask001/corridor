# Load tests

Three k6 scenarios covering the paths that decide whether Corridor holds up:
the dispatcher board, realtime fan-out, and the document extraction queue.

| Script                  | Exercises                                                | Bar                                    |
| ----------------------- | -------------------------------------------------------- | -------------------------------------- |
| `k6/movements-list.js`  | `movement.list` + `movement.board` under dispatcher load | **p95 < 500 ms**                       |
| `k6/realtime-fanout.js` | `/api/realtime/token` + N authenticated Realtime sockets | p95 < 500 ms; every channel subscribed |
| `k6/bulk-upload.js`     | signed upload → Storage → extraction queue               | **100 uploads drain within 5 min**     |

`k6/lib.js` holds the shared session loading and tRPC request helpers.

## Install k6

k6 is **not** a dependency of this repo — it is a Go binary, and pinning it in
`package.json` would put it on every `pnpm install`. Install it yourself:

```sh
# macOS
brew install k6
# Debian / Ubuntu
sudo gpg -k && sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
# anywhere with Docker
docker run --rm -i --network host -v "$PWD:/src" grafana/k6 run /src/load/k6/movements-list.js
```

Anything from k6 0.40 upward works. `realtime-fanout.js` uses `k6/ws`, which is
deprecated but present through k6 1.x; its header documents the manual
equivalent if a future release drops it.

## 1. Mint sessions

k6 cannot log in — sign-in is a Next.js Server Action and the session lives in
httpOnly cookies. `scripts/login.mjs` does the password grant against Supabase
Auth for the seeded demo users and writes `load/.sessions.json` (git-ignored;
it holds real access tokens).

```sh
pnpm load:login                                   # 1 org, 1 user
ORGS=2 DISPATCHERS_PER_ORG=4 pnpm load:login      # everything the seed has
```

Each session carries two credentials:

- **`accessToken`** — sent as `Authorization: Bearer`. `packages/api/src/context.ts`
  accepts a Bearer caller on every tRPC route (it exists for the Expo client),
  which is what lets the scripts skip the cookie session. Used by
  `movements-list.js` and `bulk-upload.js`.
- **`cookieHeader`** — the same session encoded exactly as `@supabase/ssr`
  writes it (`sb-<ref>-auth-token`, `base64-` + base64url JSON, chunked at 3180
  URI-encoded characters), plus the `corridor_org` active-org cookie. Needed for
  the routes that read the httpOnly session: page loads and
  `/api/realtime/token`. Used by `realtime-fanout.js`.

Tokens expire in about an hour (`auth.jwt_expiry`) — re-run before a long test.

Prerequisites: local Supabase up and `pnpm db:seed` run, so the demo users
(`owner@pathfinder.demo`, `dispatch@pathfinder.demo`, … / password
`corridor-demo`, plus `owner@northbound.demo` in the second org) exist. Never
point `login.mjs` at production.

## 2. Run

```sh
pnpm --filter web build && pnpm --filter web start   # or `pnpm dev`
k6 run load/k6/movements-list.js
k6 run load/k6/realtime-fanout.js
k6 run load/k6/bulk-upload.js
```

Every script exits non-zero when a threshold is missed, so they drop into CI or
a release checklist unchanged.

## Environment

| Variable              | Default                 | Meaning                                         |
| --------------------- | ----------------------- | ----------------------------------------------- |
| `BASE_URL`            | `http://localhost:3000` | The Corridor deployment under test.             |
| `ORGS`                | `1`                     | How many seeded organizations to spread across. |
| `DISPATCHERS_PER_ORG` | `1`                     | Sessions per organization.                      |
| `VUS` / `TABS`        | `20` / `50`             | Concurrency (`TABS` in the realtime script).    |
| `DURATION`, `RAMP`    | `2m`, `20s`             | Shape of the movement-list run.                 |
| `HOLD_S`              | `60`                    | How long realtime sockets stay subscribed.      |
| `UPLOADS`             | `100`                   | Documents pushed through the queue.             |
| `DRAIN_TIMEOUT_S`     | `300`                   | The five-minute drain bar.                      |

`ORGS` and `DISPATCHERS_PER_ORG` are read by both `login.mjs` (which sessions to
mint) and the k6 scripts (which of them to use), so set them the same way for
both.

## Rate limits will bite before the database does

Corridor rate-limits per plan and tier (`packages/api/src/infra/ratelimit.ts`).
Two ceilings matter here:

- **`standard`** — counted per user within an org: 60/min on the trial plan.
  `movements-list.js` sleeps 1 s per iteration to stay under it, so raising
  `VUS` past `DISPATCHERS_PER_ORG × 60` starts measuring the limiter.
- **`ai`** — counted per **organization**: 5/min on trial. `finalizeUpload` is on
  this tier, so a 100-upload run into one org is 20× over the ceiling.

Without Upstash configured the in-memory limiter multiplies every ceiling by 10
(`rateLimitMultiplier()`); override it on the **server** process:

```sh
CORRIDOR_RATELIMIT_MULTIPLIER=200 pnpm --filter web start
```

Each script records a `rate_limited` rate and fails its threshold above 1%, so a
run that hit the limiter says so rather than quietly reporting bad latency.

## Reading the results

- `movement_list_duration` / `movement_board_duration` — the p95 bar. Measured on
  dedicated Trends so the warm-up and the board query cannot flatter the number.
- `realtime_token_duration`, `socket_opened`, `channel_subscribed` — a socket that
  opens but is never confirmed against Postgres is the failure mode that matters:
  it means the token did not reach Realtime and RLS is dropping every row.
- `queue_drain_seconds`, `queue_drained`, `extraction_failed` — the drain bar.
  `bulk-upload.js` leaves its documents behind on purpose; delete them from the
  Documents screen or `pnpm db:reset && pnpm db:seed` afterwards.

`bulk-upload.js` also needs a worker: `/api/jobs/process` (Vercel Cron in
production) or the request-tail worker in `apps/web/src/lib/jobs.ts`, which runs
locally on every tRPC POST.

**Vercel Cron for `/api/jobs/process` runs once daily in production, not every
minute** — `apps/web/vercel.json` was downgraded to once-a-day schedules
(commit `0402c68`) because Hobby-tier Vercel rejects cron expressions that run
more than once per day. In production, job throughput is actually carried by
the request-tail worker (`drainDueJobs()` / `scheduleJobTail()`), which only
fires on live tRPC traffic; the cron is a once-a-day backstop, not a
per-minute safety net. This means the baseline's `while sleep 60; do curl
.../api/jobs/process; done` loop below is a *more generous* stand-in than what
production actually has — a bulk-import burst with no other concurrent app
traffic would drain far slower in production than in this baseline.

## Baseline (2026-09-12, first real run — ISSUE-010)

These three scripts existed since 2026-09-07 but had never actually been run.
Running them for the first time surfaced two real bugs in the load-testing
tooling itself, fixed alongside this baseline:

- `scripts/login.mjs` queried `organization_members` directly via
  `/rest/v1/...`. Migration `0032` removed `public` from PostgREST's exposed
  schemas entirely, so this 404'd and every session silently came back with no
  active org. Fixed to ask `organization.me` — the same tRPC procedure the web
  app itself calls to bootstrap a session — instead of the database directly.
- `k6/bulk-upload.js`'s drain check lives entirely in `teardown()`, polling for
  up to `DRAIN_TIMEOUT_S` (300s). k6 kills `teardown()` after **60s** by
  default, and the script never overrode `options.teardownTimeout` — so every
  run before this one silently truncated the drain measurement to whatever
  happened in the first minute, and the `queue_drained`/`queue_drain_seconds`
  thresholds "passed" vacuously (zero samples, not zero problems). Fixed by
  setting `teardownTimeout` to `DRAIN_TIMEOUT_S + 30s`.

Run against a local build (`pnpm --filter web build && pnpm --filter web
start`, `CORRIDOR_RATELIMIT_MULTIPLIER=200`, no Upstash), local Supabase,
default `pnpm db:seed` data:

| Script               | Bar                                   | Result                                                                                                 |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `movements-list.js`  | p95 < 500ms (both metrics)            | ✅ `movement_list_duration` p95 = **144ms**, `movement_board_duration` p95 = **95ms**, 0% rate-limited |
| `realtime-fanout.js` | p95 < 500ms; every channel subscribed | ✅ `realtime_token_duration` p95 = **93ms**, 100% sockets opened, 100% channels subscribed             |
| `bulk-upload.js`     | 100 uploads drain within 5 minutes    | ⚠️ **91/100** drained in 300s, 0% extraction failures, 0% rate-limited                                 |

The first two scripts pass comfortably with headroom to spare. `bulk-upload.js`
narrowly misses its own bar. This needed two attempts to measure honestly:

- A first attempt against a database with backlog left over from an earlier
  interrupted run measured only 6/100 — an artifact of old undrained jobs
  competing for the same per-organization concurrency slot
  (`claim_jobs(p_org_cap default 2)`), not a real capacity number. Discard any
  reading taken without a clean `pnpm exec supabase db reset && pnpm db:seed`
  immediately before the run.
- The clean run above also ran a script polling `/api/jobs/process` once a
  minute for the run's duration, standing in for a per-minute cron safety net.
  **Production's actual `/api/jobs/process` cron runs once daily, not once a
  minute** (Vercel Hobby plan limit, see "Vercel Cron" note above) — this
  baseline's polling loop is therefore more generous than production, where
  extraction advances almost entirely as a side effect of incoming HTTP
  traffic (`drainDueJobs()` in `apps/web/src/lib/jobs.ts`), which the k6
  script's own request traffic provides unevenly. Reproduce with:
  ```sh
  CRON_SECRET=<something> pnpm --filter web start   # in addition to CORRIDOR_RATELIMIT_MULTIPLIER
  while sleep 60; do curl -s localhost:3000/api/jobs/process -H "authorization: Bearer <something>"; done &
  ```

The 9 undrained documents were still `processing`, not `failed` — direct
inspection of `background_jobs` during the run showed individual
`document.extract` jobs completing in ~4s on average, consistent with the
org's 2-concurrent-extraction cap being the throttle, not an error. A slightly
longer window would very likely clear the rest; this wasn't re-verified to
avoid burning more real OpenAI API calls on the same measurement.

**Decision (2026-09-14):** raise the app-level default org cap from 2 to 4 —
`jobOrgCap()` in `packages/api/src/services/jobs.ts` (env override
`CORRIDOR_JOB_ORG_CAP`, no migration needed; `public.claim_jobs`'s own SQL
default stays 2 for any direct caller that omits the argument). Cap 4 halves
the theoretical drain time for a 100-doc single-tenant burst (~200s → ~100s
at ~4s/doc), well inside the 5-minute bar, at the cost of doubling per-org
concurrent OpenAI extraction calls. This wasn't re-run against a clean
baseline to confirm 100/100 — do that before relying on the number in a
release checklist. The cron cadence finding above is a separate, non-optional
fix: without it, a bulk-import burst with no concurrent app traffic drains
far slower in production than this local baseline measured.
