# BorderConnect customs gateway adapter — design

Status: approved for implementation in chat on 2026-09-10

## Why

Corridor's customs integration (0023) supports `mock` (deterministic, in-process) and `gateway`
(a generic certified-EDI-gateway REST client: `Authorization: Bearer <key>` against
`/manifests`, `/manifests/{ref}`, `/in-bond/{bond}`, `/notices`). EasyTask AI Corp's
BorderConnect eManifest API account is now credentialed (`.env.local`:
`BORDERCONNECT_API_KEY`, `BORDERCONNECT_API_WEBSOCKET_URL`), but BorderConnect does not speak
that generic contract. Its protocol is message-oriented, not resource-oriented:

- Auth is an `Api-Key` header, not `Authorization: Bearer`.
- There is no per-reference `GET /manifests/{ref}`. `POST /api/send/[suffix]` uploads messages;
  `GET /api/receive/[suffix]` drains **every** message queued for the account, unscoped to any
  one reference.
- Filing is two concepts, not one REST resource: an `ACE_TRIP`/`ACI_TRIP` upload, optionally
  auto-transmitted (`autoSend`), plus a separate `ACE_SEND_REQUEST`/`ACI_SEND_REQUEST` message
  for anything after the initial filing (amend, cancel).
- There is no bond-number-keyed in-bond API matching Corridor's `InBondMessage` (CBP Form 7512
  style: `bondNumber`, `entryType`, `firmsCode`). The closest BorderConnect concept
  (`INBOND_ARRIVAL`/`INBOND_EXPORT` on an ACE `ACE_SEND_REQUEST`) is a different thing: trip-level
  arrival/export dates on an already-filed ACE eManifest, not a Form 7512 bond movement. The
  actual matching BorderConnect product ("U.S. In-Bond Manager" / QP In-Bond, under
  `/app/us/abi/wp/...`) is a separate, unresearched API surface.
- There is no generic "carrier service notice" broadcast. The closest thing, `ACI_NOTICE`, is a
  per-shipment status update keyed by cargo control number, a different concept from Corridor's
  `CarrierNotice` (systemic CBP/CBSA service notices).

This document designs a BorderConnect-specific adapter that implements the existing
`CustomsClient` interface without distorting BorderConnect's protocol to fit the generic
gateway's assumptions, and without silently mismapping the two CBP concepts above.

## Goals

1. File and track ACE and ACI eManifests (transmit, amend, cancel, fetchStatus, fetchDecision,
   ping) through the real BorderConnect API, selectable per organization alongside `mock` and the
   existing generic `gateway` mode.
2. No message BorderConnect ever queues is silently dropped, even when it belongs to a
   reference other than the one currently being polled.
3. No compliance-relevant mismapping: where a Corridor `CustomsClient` capability has no honest
   BorderConnect equivalent, the adapter fails loudly (`CustomsTransportError`) instead of
   approximating.
4. Every unconfirmed protocol detail is marked as such in code and this document, not asserted as
   fact from a single example payload.
5. Same offline-by-default posture as the rest of the repo: `border_connect` mode with no
   configured API key replays fixtures, so tests and demos need no credentials.

## Non-goals

- Implementing BorderConnect's WebSocket transport. The HTTP send/receive pair is sufficient and
  fits Corridor's existing cron-driven polling job (`customs.poll_status`); a persistent
  WebSocket connection would need new always-on worker infrastructure this repo doesn't have.
- Implementing `fetchNotices` or any of the four `inBondArrival`/`inBondExport`/`inBondCancel`/
  `inBondStatus` methods for BorderConnect. Both throw `CustomsTransportError` with a clear
  "not supported by BorderConnect" message. Revisiting either requires separate research
  (BorderConnect's QP In-Bond Manager API for in-bond; there is no notice-broadcast equivalent
  to research for notices).
- Restructuring `packages/api/src/services/jobs.ts`'s per-movement poll loop into a per-organization
  mailbox drain. The existing "one `customs.poll_status` job per movement, self-rescheduling while
  pending" model is kept; BorderConnect's adapter fits inside it (see Data flow).
- Service-provider mode (`companyKey`-scoped multi-carrier connections). EasyTask AI Corp
  connects as a single carrier; `companyKey` is not sent.

## Chosen architecture

New package `packages/integrations/src/customs/borderconnect/`, parallel to `gateway/` but not
sharing its `transport.ts`/`mapping.ts`/`client.ts` — the wire protocol is different enough that
forcing a shared abstraction would blur both.

### `transport.ts`

```ts
interface BorderConnectTransportOptions {
  apiUrlSuffix: string; // e.g. "EasyTask" — the account's assigned suffix
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
interface BorderConnectTransport {
  send(message: Record<string, unknown>): Promise<unknown>; // POST /api/send/[suffix]
  receive(): Promise<unknown[]>; // GET /api/receive/[suffix] — drains the queue
}
```

- `Api-Key: <apiKey>` header on both calls (never `Authorization: Bearer`).
- A non-2xx response is parsed as `{status: "FAILURE", errorCode: "..."}` (confirmed shape) and
  raised as `CustomsTransportError`; `429`/`5xx` retryable, matching `transport.ts`'s existing
  `retryable()` convention. Confirmed error codes: `MISSING_API_KEY`, `INVALID_API_KEY`,
  `EXPIRED_API_KEY`, `API_KEY_URL_MISMATCH`, `FAILED_TO_IMPORT_DATA`, `WRONG_HTTP_METHOD`,
  `TOO_MANY_REQUESTS`.
- `receive()`'s success response shape (single message vs. array) is **not confirmed** by any
  fetched documentation page. The implementation normalizes to an array (wrapping a bare object
  in `[]` if the body isn't already an array) and this must be verified against a live sandbox
  call before `border_connect` mode is enabled for a real organization.

### `mapping.ts`

- `toTripMessage(manifest: ManifestPayload, opts: { sendId: string }): Record<string, unknown>` —
  builds `ACE_TRIP`/`ACI_TRIP` (branching on `manifest.regime`) with `operation: "CREATE"`,
  `autoSend: true`, `tripNumber: manifest.trip.movementNumber`. `transmit()` needs only this one
  call; there is no separate send-request round trip for an original filing.
- `toSendRequestMessage(kind: "amend" | "cancel", regime, tripNumber, sendId)` — builds
  `ACE_SEND_REQUEST`/`ACI_SEND_REQUEST` with the confirmed `type` values:
  - ACE: `AMEND_TRIP_AND_SHIPMENTS` / `CANCEL_TRIP_AND_SHIPMENTS`
  - ACI: `AMEND` / `CANCEL`
    `amend()` also re-uploads the trip body first via `toTripMessage` with
    **`operation: "UPDATE"` — unconfirmed.** Only `"CREATE"` appears in any fetched BorderConnect
    example or PDF reference. This is called out with an inline comment and must be confirmed
    against BorderConnect (sandbox test or their support) before amendments are used in production;
    until then `amend()` in `border_connect` mode is considered experimental.
- `fromInboundMessage(msg: unknown): { referenceNumber: string | null; shipmentControlNumbers:
string[]; status: CustomsStatusMessage }` — branches on `msg.data`:
  - `API_RESPONSE` (`status: OK|IMPORTED|DATA_ERROR`) → acknowledgement of the upload itself,
    maps to `"pending"`/`"rejected"` respectively (`DATA_ERROR` before customs ever sees it is a
    local rejection, not a CBP/CBSA decision).
  - `ACE_RESPONSE` (`processingResponse.shipmentsAccepted/shipmentsRejected`) → `"accepted"` or
    `"rejected"`; ACE has no separate ongoing-status message type in the fetched docs, so this is
    also where later status changes are expected to arrive (unconfirmed — flagged for the same
    sandbox verification pass as amend).
  - `ACI_RESPONSE` (`type: ACCEPT|REJECT`, keyed by `tripNumber`) → `"accepted"`/`"rejected"`.
  - `ACI_NOTICE` (keyed by `cargoControlNumber`, not `tripNumber`) → resolved to its owning trip
    through the store (below) before being turned into a `CustomsStatusMessage`.

### `client.ts`

`createBorderConnectCustomsClient(opts: { provider, environment, apiUrlSuffix, apiKey, store,
transport?, now? })` implements `CustomsClient`:

- `transmit` → one `send()` call with `toTripMessage(...)`.
- `amend` → `send()` the updated trip body, then `send()` the `AMEND_*` send-request.
- `cancel` → `send()` the `CANCEL_*` send-request only (no trip re-upload; cancel doesn't need
  shipment data).
- `fetchStatus`/`fetchDecision` → the drain-then-serve cycle (Data flow, below).
- `ping` → `receive()` and report `ok: true` on any non-throwing response (200), `ok: false` on
  an authentication or transport error. BorderConnect has no dedicated health endpoint.
- `fetchNotices`, `inBondArrival`, `inBondExport`, `inBondCancel`, `inBondStatus` → immediately
  throw `new CustomsTransportError("... not supported by BorderConnect", 501, false)`.

### `store.ts` — the necessary deviation from the gateway client's pattern

The existing gateway `client.ts` never touches the database; `transport.ts`'s `HttpTransportOptions`
takes only `baseUrl`/`apiKey`. That works because a generic gateway answers "what's the status of
reference X" directly. BorderConnect cannot: `GET /api/receive` drains everything queued for the
account in one shot, not filtered to one trip. If `fetchStatus(refA)` drains the queue and finds
messages for `refA`, `refB`, and `refC`, but only returns `refA`'s and discards the rest, `refB`
and `refC`'s messages are gone forever — BorderConnect does not requeue what it has already handed
out.

So the BorderConnect client is given a small injected store, unlike the generic gateway client:

```ts
interface BorderConnectSubmissionStore {
  /** Resolve a drained message's tripNumber, or an ACI_NOTICE's cargoControlNumber (via the
   *  shipments recorded in customs_submissions.request), to the customs_submissions row it
   *  belongs to. Null when no matching submission exists yet (message dropped, logged). */
  resolveReference(key: {
    tripNumber?: string;
    cargoControlNumber?: string;
  }): Promise<string | null>;
  /** Cache one drained-but-not-yet-consumed message against its reference. */
  cachePendingMessage(referenceNumber: string, message: unknown): Promise<void>;
  /** Read and clear the cached message for a reference (the "serve" half of drain-then-serve).
   *  Null when nothing new has arrived since the last read. */
  takePendingMessage(referenceNumber: string): Promise<unknown | null>;
}
```

Backed by Drizzle against `customs_submissions`, constructed with the `tx` and `orgId` already in
scope at `customsClientFor()` (`packages/api/src/services/customs.ts`) — the same place that
today builds the generic gateway client. `resolveReference` reads `customs_submissions.reference_number`
directly for a `tripNumber` match, or scans `customs_submissions.request->'shipments'` for a
`cargoControlNumber`/`controlNumber` match. `cachePendingMessage`/`takePendingMessage` read/write
the new `customs_submissions.pending_inbound` column (below).

This keeps the `CustomsClient` interface itself unchanged and keeps `pollCustomsStatus`/
`applyStatusMessage` in `services/customs.ts` completely unaware that BorderConnect's
`fetchStatus` call has a side effect of caching other movements' messages: those movements pick
their own cached message up next time their own `customs.poll_status` job calls `fetchStatus`,
which already happens on a self-rescheduling loop while a filing is pending.

## Data flow

**Transmit:**
`transmitMovement` (unchanged) → `client.transmit(manifest)` → one `POST /api/send/[suffix]` with
an `autoSend: true` `ACE_TRIP`/`ACI_TRIP`. `recordSubmission` (unchanged) stores the ack.

**Poll (`customs.poll_status` job, per movement, self-rescheduling while pending — unchanged
job shape):**

1. `client.fetchStatus(ref)` calls `transport.receive()`, draining every message currently queued
   for the account.
2. For each drained message, `mapping.fromInboundMessage` extracts its `data` type and
   correlating key (`tripNumber` or `cargoControlNumber`); `store.resolveReference` finds which
   `customs_submissions` row it belongs to (or drops it with a log, mirroring
   `applyInboundCustomsMessage`'s existing "unknown reference" no-op); `store.cachePendingMessage`
   writes it to that row's `pending_inbound`.
3. `store.takePendingMessage(ref)` reads and clears _this_ reference's cache. Nothing new →
   `fetchStatus` returns the same status as last time (`"pending"` while the last cached message
   hasn't changed that).
4. The returned `CustomsStatusMessage` flows into `applyStatusMessage` exactly as it does for
   `mock`/`gateway` today — no changes there.

**Amend / cancel:** as in "Chosen architecture" above; `transmitAmendment`/`cancelAtCustoms`
(unchanged) call `client.amend`/`client.cancel`, which are two-message and one-message send-only
operations respectively.

## Schema change

One migration:

- `integration_configs.mode` and `customs_submissions.mode`: widen the enum to add
  `"border_connect"` alongside `"mock"`/`"gateway"`.
- `customs_submissions`: add `pending_inbound jsonb` (nullable). Provider payload data — fits the
  existing "jsonb is for provider payloads and free-form metadata" rule; not a settings bag. Every
  other field the drain-then-serve cycle needs (`reference_number`, `request` for shipment control
  number resolution) already exists.
- `integration_configs.base_url`, for `border_connect` mode only, is reinterpreted as the
  account's **API URL suffix** (e.g. `EasyTask`) rather than a full base URL — `transport.ts`
  hardcodes the `borderconnect.com` host. Documented in the adapter's README and in a migration
  comment, since this repurposes an existing generic column's meaning for one mode rather than
  adding a new one.

Mirrored in `packages/db/src/schema/integrations.ts` per the usual migration → schema → `db reset`
→ `verify:mirror` → `db:lint` → `test:integration` sequence.

## Wiring

- `packages/integrations/src/customs/index.ts`: `createCustomsClient` gains a `border_connect`
  branch calling `createBorderConnectCustomsClient`, alongside the existing `mock`/`gateway`
  branches.
- `packages/api/src/services/customs.ts`: `customsClientFor` builds a `BorderConnectSubmissionStore`
  from `tx`/`orgId` and passes it (only) when `mode === "border_connect"`. `apiUrlSuffix` comes
  from `cfg.baseUrl`; `apiKey` from the same Vault/env fallback path already used for `gateway`
  (`credentials?.apiKey ?? process.env.CUSTOMS_GATEWAY_API_KEY`) — extended to also fall back to
  `process.env.BORDERCONNECT_API_KEY` for `border_connect` mode, matching the env var already
  added to `.env.local`/`.env.example`.

## Fixture replay (offline default)

`createFixtureBorderConnectTransport()`, mirroring `gateway/client.ts`'s
`createFixtureGatewayTransport`: no `apiKey` configured → replays canned `send`/`receive`
fixtures under `borderconnect/fixtures/`, so `border_connect` mode runs in CI and demos with no
credentials, consistent with every other external service in this repo.

## Testing

- `borderconnect/client.test.ts`, mirroring `gateway/client.test.ts`'s coverage: transmit →
  fixture ack; fetchStatus draining a fixture `ACE_RESPONSE`/`ACI_RESPONSE`/`ACI_NOTICE` into the
  right reference; a second `fetchStatus` on an unrelated reference proving the first drain's
  unrelated message was cached, not dropped; amend and cancel message shapes; `ping` success and
  auth-failure cases.
- A dedicated test that `fetchNotices` and all four `inBond*` methods throw
  `CustomsTransportError` with the "not supported" message, so a future change can't silently
  make them succeed with a wrong mapping.
- `pnpm --filter @corridor/db verify:mirror`, `pnpm db:lint`, `pnpm test:integration` for the
  migration, per the repo's standard schema-change checklist.

## Open risks carried into implementation (not resolved by this design)

1. `GET /api/receive` response shape when messages are pending (array vs. single object) —
   unconfirmed, needs a live sandbox call.
2. `operation: "UPDATE"` for amend's trip re-upload — unconfirmed, only `"CREATE"` is evidenced.
3. Whether ACE has a distinct ongoing-status message beyond `ACE_RESPONSE` — unconfirmed.

None of these block writing the adapter (it's built defensively around them and fails loudly
rather than guessing wrong), but all three should be confirmed against BorderConnect's sandbox
(or their support) before `border_connect` mode is turned on for a production organization.
