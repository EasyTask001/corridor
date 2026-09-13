# @corridor/borderconnect-listener

A standalone Node app that opens a persistent WebSocket to BorderConnect's
`wss://borderconnect.com/api/sockets/{suffix}` Service Provider endpoint and
writes every frame it receives into the same `customs_inbox` table the
existing HTTP drain (`packages/api/src/services/borderconnect.ts`'s
`storeInboundMessages`, run every minute by
`apps/web/src/app/api/jobs/borderconnect-drain/route.ts` via
`drainBorderConnectInbox`) already reads from.

## What it does, and does not do

- Connects, sends `{"apiKey": "..."}` as its first frame within 10s of
  connecting, and treats the server's first `API_RESPONSE`
  `{"data":"API_RESPONSE","status":"OK","message":"Connected",...}` as
  authentication succeeding.
- Every frame after that ack is handed to `storeInboundMessages` inside a
  `withServiceRole` transaction, unchanged from how the HTTP drain stores
  what it polls — same table, same `payload_sha256` dedup, so a message the
  socket sees and a message later supplied to the inbox store with the same
  content collapse into one row rather than duplicating.
- On `ACCESS_DENIED_ERROR` (a bad/expired key), the socket closes and this
  app does **not** reconnect — retrying a dead key would just hammer
  BorderConnect. Any other close reconnects with capped exponential backoff
  (1s, doubling, capped at 60s; reset to 1s once a connection re-authenticates).
- Sends a WebSocket ping every 30s once authenticated, to keep the
  connection alive.
- **This app is not deployed.** It is not wired into `apps/web`, any cron
  job, Vercel, or any other running infrastructure in this repo. It exists so
  the WebSocket alternative to HTTP polling is a working, tested artifact
  ready for a future decision about whether (and where) to run it
  continuously — see `docs/superpowers/specs/2026-09-10-borderconnect-customs-adapter-design.md`'s
  "WebSocket listener (hosting deferred)" section.
- It deliberately does **not** touch the cron drain job or its route. During
  the pilot it must run only in an isolated test window with the HTTP drain
  stopped and no customer filing; the two live receive transports must never
  run concurrently while their queue semantics remain unconfirmed.
- Sentry captures listener exceptions and traces through the shared telemetry
  scrubber, and optional OTLP metrics report inbox receive/store/duplicate
  counts. No raw frame or routing key is attached to telemetry.

## Open question: does an open socket divert the HTTP polling queue?

BorderConnect's shared inbox (`GET /api/receive/{suffix}`) is documented as a
queue that gets **drained** by whoever reads it. It is not confirmed whether
holding an open WebSocket to the same account also diverts messages away from
that HTTP queue (i.e. whether a message delivered over the socket is _also_
still sitting there for the next `GET /api/receive` poll, or whether the
socket and the poller are competing consumers of one queue). If the two
transports do compete, running both against the same account at the same time
could mean the cron drain silently sees fewer messages while the socket is
up — worth knowing before ever relying on this app.

This needs live verification against a real BorderConnect sandbox account,
which this task cannot do (no live credentials, and this repo's policy is
that every external integration degrades to a deterministic mock/fixture
when its env var is unset — there is nothing to connect to here without
real credentials). **Task 16's smoke script** is where that verification is
planned: run this container locally against a real account, send a test
message, and confirm whether it still shows up over `GET /api/receive` too.
Until that's confirmed, treat "run the socket and the poller simultaneously
against a live account" as unverified, not as a settled design.

## Running it locally

Requires `BORDERCONNECT_API_URL_SUFFIX`, `BORDERCONNECT_API_KEY` (the same
Service Provider credentials `apps/web` uses for the HTTP transport) and
`DATABASE_URL` (a service-role Postgres URL — the local Supabase stack's is
`postgresql://postgres:postgres@127.0.0.1:55322/postgres`, per this repo's
`supabase/config.toml` port range). No `SUPABASE_*` vars are needed: this app
never uses `supabase-js`, only `@corridor/db`'s `getDb()`/`withServiceRole()`,
which talk to Postgres directly over `DATABASE_URL`.

Also configure `BORDERCONNECT_SPOOL_DIR` on a persistent 0700 volume and
`BORDERCONNECT_SPOOL_KEY` with a random 32-byte hex or base64 secret. Frames
are encrypted into this spool before the database insert and are replayed on
restart; the listener stops instead of dropping a batch when persistence fails.

Set `BORDERCONNECT_API_URL_SUFFIX`, `BORDERCONNECT_API_KEY`, and `DATABASE_URL`
in a private environment file or secret manager, then run:

```bash
pnpm --filter @corridor/borderconnect-listener dev
```

Or via Docker (build only — not deployed anywhere, this is the "runnable
artifact" for later):

```bash
docker build -t corridor-borderconnect-listener -f apps/borderconnect-listener/Dockerfile .
docker run --rm \
  --env-file /path/to/private/environment \
  corridor-borderconnect-listener
```

## What's been verified live vs. what hasn't

While self-reviewing this app locally (`pnpm --filter @corridor/borderconnect-listener
deploy --legacy <dir>` then running the deployed folder directly with
`tsx`), a throwaway invalid key genuinely reached
`wss://borderconnect.com/api/sockets/{suffix}` and the app correctly parsed
the real server's `ACCESS_DENIED_ERROR` frame and did not reconnect — so
the endpoint path, the `deploy --legacy` packaging, and this app's
access-denied handling are confirmed against the real server, not just the
test's fake `WebSocket`. What is **not** verified live: a real key's
`API_RESPONSE`/"Connected" ack shape, real inbound message frame shapes, and
the polling-divergence question above — all of that needs real credentials,
which this task doesn't have.

## Tests

`pnpm --filter @corridor/borderconnect-listener test` runs `src/socket.test.ts`
against a deterministic fake `WebSocket` (an injected `wsFactory`, never the
real `ws` library) using Vitest's fake timers — no real network connection
and no real delay for the 10s auth timeout, 30s ping interval or the
1s→60s backoff sequence.
