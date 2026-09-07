# `@corridor/mobile` — Corridor Driver

An Expo (SDK 54) driver app for the loads a Driver-Portal member is assigned
to. It talks to the **same** tRPC router as the web app over
`Authorization: Bearer <supabase access token>`, so every permission check, RLS
policy and audit row behaves identically on a handset and in a browser.

There is no second backend and no mobile-only API: `packages/domain` and
`packages/api` stay free of React Native, and this app consumes them.

## Quick start

```bash
pnpm install

# 1. Point the app at the API and Supabase.
cp apps/mobile/.env.example apps/mobile/.env.local
#    Use your machine's LAN IP, not localhost — a phone cannot reach your loopback.
#    EXPO_PUBLIC_SUPABASE_ANON_KEY comes from `pnpm exec supabase status`.

# 2. Run the Next.js API and a seeded local database in another shell.
pnpm exec supabase db reset && pnpm db:seed
pnpm --filter web dev

# 3. Start Metro and open the QR code in Expo Go.
pnpm --filter @corridor/mobile start
```

Sign in with a seeded Driver-Portal account (see `packages/db/scripts/seed.ts`).

Checks, all runnable without a device or an emulator:

```bash
pnpm --filter @corridor/mobile typecheck
pnpm --filter @corridor/mobile lint
pnpm --filter @corridor/mobile test
```

## Screens

| Route                                    | What it does                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `app/(auth)/sign-in.tsx`                 | Email + password against Supabase Auth                                      |
| `app/(driver)/index.tsx`                 | Assigned loads via `movement.list` (`movement.read_assigned`)               |
| `app/(driver)/movement/[id].tsx`         | Status, crossing, cargo and the event timeline (`movement.get`)             |
| `app/(driver)/movement/[id]/capture.tsx` | Camera / library → `documents.getUploadUrl` → signed PUT → `finalizeUpload` |
| `app/(driver)/movement/[id]/pod.tsx`     | Signature pad → PNG → uploaded as `document_type: 'other'`                  |
| `app/(driver)/notifications.tsx`         | `notifications.list` + `markRead`                                           |

## How it fits together

**Auth (`src/lib/supabase.ts`).** The session is kept in `expo-secure-store`
(the OS keychain / keystore), chunked across keys because SecureStore rejects
values over 2 KB and a Supabase session is routinely larger.

**tRPC (`src/lib/trpc.ts`).** `httpBatchLink` to `${EXPO_PUBLIC_API_URL}/api/trpc`
with `superjson`, an `Authorization: Bearer` header taken from the live session
and `x-corridor-org` pinned to the driver's active org. `AppRouter` is imported
**type-only**, so no server code reaches the bundle.

**Offline outbox (`src/lib/outbox.ts`).** Drivers lose signal at the border, so
mutations are queued in AsyncStorage and replayed when NetInfo reports a
connection. Every entry is validated against the _same_ `packages/domain` Zod
schema the tRPC procedure uses — once before it is persisted, and again before
it is replayed, so a payload written by an older build can never reach the
server in a shape the router would reject. The module imports nothing from
React Native (storage, connectivity and transport are injected by
`src/lib/outbox-client.ts`), which is what lets Vitest exercise the whole
replay path. Queued operations are limited to idempotent ones, because a replay
can happen twice if the app is killed between the send and the removal.

The queue is keyed **per user** (`corridor.outbox.v1.<auth user id>`) and the
scope follows every auth state change, so on a shared handset one driver's
unsent mutations can never replay under the next driver's token. Sign-out
additionally drains what it can and then clears the queue unconditionally,
logging a warning with the count of anything discarded.

The scope has a third state, `unresolved`, held until the stored Supabase
session has actually been read. While unresolved the outbox refuses to enqueue
and no-ops on flush and clear, and connectivity tracking has not started yet —
so the launch-time replay can only ever run once it knows whose queue it is.

**Uploads (`src/lib/upload.ts`).** Reserve + sign and the direct PUT need a live
connection by nature, so a capture with no signal fails fast rather than
pretending it was stored; only `documents.finalizeUpload` goes through the
outbox.

**Signature capture (`src/lib/signature.ts`).** PanResponder collects raw touch
points; the module renders them to an SVG path for the live preview and encodes
an 8-bit greyscale PNG (stored-deflate zlib stream, CRC and Adler checksums) in
pure TypeScript. That avoids both a WebView-backed canvas and
`react-native-view-shot`, keeps the encoder unit-testable, and produces
`pod-signature.png` with `image/png` — a MIME type the document API already
accepts, so no allow-list had to be widened for an SVG.

**Push (`src/lib/push.ts`).** `expo-notifications` obtains an Expo push token,
which is stored by `notifications.registerDevice` in `user_devices`
(migration 0015, user-scoped RLS). The server-side fan-out in
`packages/api/src/services/notifications.ts` sends to every device of a
recipient whose notification rule includes the `push` channel — adjustable per
event type under **Settings → Notifications** in the web app. Sends are mocked
unless `EXPO_PUSH_ENABLED=true`, and either way they are recorded in
`integration_events` with provider `expo_push`.

The event drivers actually receive is **`movement.assigned`** — emitted by
`movement.update` when a dispatcher sets or changes a movement's driver,
delivered only to the auth user linked to that driver (`drivers.user_id`),
never to the dispatcher who made the change, and defaulting to `in_app + push`.
Because it is targeted at one recipient rather than fanned out, it goes through
`notifyUser` in a service-role transaction rather than `notify_organization` —
dispatched by the router _after_ its own transaction commits.

Push tokens are treated as bearer capabilities: `push_tokens_for` (migration 0015) is `EXECUTE`-granted to `service_role` only, so no authenticated caller —
in this org or any other — can read another member's handset tokens. Reaching
the service role while a user's RLS transaction is open would hold two pooled
connections per request, so nothing pushes inline: the org fan-out enqueues a
`notification.push` job (migration 0016) for the worker to deliver, and
`movement.assigned` is dispatched by the router only after its transaction has
committed.

## Secrets

The app holds exactly two credentials, both public by design: the Supabase
**anon** key and `EXPO_PUBLIC_API_URL`. `EXPO_PUBLIC_*` values are inlined into
the JS bundle by Metro, so nothing else may ever be added there — the
service-role key, Stripe keys and model keys stay on the server.

## Monorepo notes

`metro.config.js` watches the repo root, resolves from both the app's and the
root's `node_modules`, and sets `disableHierarchicalLookup` so a package can
never be resolved out of a `.pnpm` directory that merely sits above it on disk.

Native builds (`expo prebuild`, EAS) have deliberately not been run: `/ios` and
`/android` are ignored, and everything above is verified from the CLI.
