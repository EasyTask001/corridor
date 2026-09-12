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
  socket sees and a message the cron drain later polls for the same content
  collapse into one row rather than duplicating.
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
- It deliberately does **not** touch the cron drain job or its route —
  running this listener and the HTTP poller at the same time is intended to
  be safe (`storeInboundMessages`'s `payload_sha256` dedup is exactly the
  mechanism that makes overlap harmless), not a replacement for one or the
  other.

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

```bash
export BORDERCONNECT_API_URL_SUFFIX=EasyTask
export BORDERCONNECT_API_KEY=...
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres
pnpm --filter @corridor/borderconnect-listener dev
```

Or via Docker (build only — not deployed anywhere, this is the "runnable
artifact" for later):

```bash
docker build -t corridor-borderconnect-listener -f apps/borderconnect-listener/Dockerfile .
docker run --rm \
  -e BORDERCONNECT_API_URL_SUFFIX=EasyTask \
  -e BORDERCONNECT_API_KEY=... \
  -e DATABASE_URL=postgresql://... \
  corridor-borderconnect-listener
```

## Tests

`pnpm --filter @corridor/borderconnect-listener test` runs `src/socket.test.ts`
against a deterministic fake `WebSocket` (an injected `wsFactory`, never the
real `ws` library) using Vitest's fake timers — no real network connection
and no real delay for the 10s auth timeout, 30s ping interval or the
1s→60s backoff sequence.
