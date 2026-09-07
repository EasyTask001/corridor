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
