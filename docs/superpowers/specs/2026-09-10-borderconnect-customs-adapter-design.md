# BorderConnect customs gateway adapter — design

Status: superseded 2026-09-12 — Service Provider mode, shared inbox; implemented by docs/superpowers/plans/2026-09-12-borderconnect-service-provider.md

## Why

Corridor's customs integration (0023) supports `mock` (deterministic, in-process) and `gateway`
(a generic certified-EDI-gateway REST client: `Authorization: Bearer <key>` against
`/manifests`, `/manifests/{ref}`, `/in-bond/{bond}`, `/notices`). An approved
BorderConnect eManifest API Service Provider account is configured only through
the private environment (`BORDERCONNECT_API_KEY`, `BORDERCONNECT_API_URL_SUFFIX`), but BorderConnect does not speak
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
  fits Corridor's existing cron-driven polling job (`customs.borderconnect_drain`); a persistent
  WebSocket connection would need new always-on worker infrastructure this repo doesn't have.
- Implementing `fetchNotices` or any of the four `inBondArrival`/`inBondExport`/`inBondCancel`/
  `inBondStatus` methods for BorderConnect. Both throw `CustomsTransportError` with a clear
  "not supported by BorderConnect" message. Revisiting either requires separate research
  (BorderConnect's QP In-Bond Manager API for in-bond; there is no notice-broadcast equivalent
  to research for notices).
- Carrier-key (non-SP) mode: not built; `companyKey` is always sent.

## Chosen architecture

New package `packages/integrations/src/customs/borderconnect/`, parallel to `gateway/` but not
sharing its `transport.ts`/`mapping.ts`/`client.ts` — the wire protocol is different enough that
forcing a shared abstraction would blur both.

### `transport.ts`

```ts
interface BorderConnectTransportOptions {
  apiUrlSuffix: string; // the account's assigned suffix, supplied through the environment
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

### Outbound mappers (`ace.ts`, `aci.ts`, `send-request.ts`, `validate.ts`)

- `toAceTrip(manifest, opts): ACE_TRIP` — builds `ACE_TRIP` with fields from `ManifestPayload`
  extended in Task 3 (carrier code, timezone, crew dateOfBirth, truck type, shipment loading
  place, delivery postal address, commodity packaging & units). `operation` (CREATE | UPDATE),
  `autoSend`, `companyKey` passed through `opts`; `companyKey` also on every nested shipment.
  Throws `CustomsTransportError` 422 listing every missing required field at once.
- `toAciTrip(manifest, opts): ACI_TRIP` — builds `ACI_TRIP`, same error handling.
- `toCancelSendRequest(regime, tripNumber, opts): ACE_SEND_REQUEST | ACI_SEND_REQUEST` —
  ACE: `{ data: "ACE_SEND_REQUEST", type: "CANCEL_TRIP_AND_SHIPMENTS", … }`;
  ACI: `{ data: "ACI_SEND_REQUEST", type: "CANCEL", bundleTripAndShipments: true, … }`.
- `validateForBorderConnect(manifest): string[]` — collects all compliance problems (missing
  carrier code, bad trip number pattern, unsupported shipment types, hazmat/in-bond flags, etc.);
  returns empty list when valid.

### `client.ts`

`createBorderConnectCustomsClient(opts: { provider, environment, apiUrlSuffix, apiKey, companyKey,
transport?, now? })` implements `CustomsClient`:

- `transmit` → one `send()` call with `toAceTrip|toAciTrip(..., {operation: "CREATE", autoSend: true, companyKey})`.
  Returns `{referenceNumber: tripNumber, receivedAt: ..., raw: {...}}`.
- `amend` → `send()` the updated trip with `operation: "UPDATE"` (same `tripNumber`), then
  `send()` the `AMEND_*` send-request. Throws if trip re-upload is unconfirmed with BorderConnect.
- `cancel` → `send()` the `CANCEL_*` send-request only.
- `fetchStatus`, `fetchDecision`, `fetchNotices`, `inBond*` → throw `CustomsTransportError` 501
  — status arrives through the shared inbox drain, not per-movement polling.
- `ping()` → `receive()` and report; **not used in production** (drains the queue). Task 10 routes
  the "Test connection" button to the drain instead.

### Service Provider identity

- `organizations.border_connect_company_key: text | null` — each carrier organization's assigned
  `companyKey` from BorderConnect. The service-provider account connects with a single API key
  and API URL suffix (from env: `BORDERCONNECT_API_KEY`,
  `BORDERCONNECT_API_URL_SUFFIX`), multiplexing all tenants through a shared queue. Outbound
  messages include the organization's `companyKey` on every trip and nested shipment.
- Router: when `mode === "border_connect"` is selected, require `companyKey` to be set on the
  organization. Production fails fast with `PRECONDITION_FAILED` if it is not.

### Shared inbox

- `customs_inbox` table (grain: one inbound message from the shared BorderConnect queue, before its
  tenant is known):
  - `id`, `provider` (always `'border_connect'`), `company_key`, `data_type` (the message's `data`
    field), `send_id`, `trip_number`, `cargo_control_number`, `shipment_control_number`,
    `payload` (the full JSON), `payload_sha256` (dedup on retries / socket+poll overlap), `received_at`.
  - After processing: `organization_id` (resolved by `company_key`), `customs_submission_id`
    (resolved by `tripNumber` or `cargoControlNumber`), `movement_id` (resolved from submission),
    `processed_at`, `processing_error` (unroutable messages kept with their error for Settings UI).
  - RLS: `organization_id is not null and has_permission(organization_id, 'integrations.manage')`
    for authenticated read; service role reads all.
- Drain job `customs.borderconnect_drain` (cron, every minute):
  1. `transport.receive()` from the shared queue.
  2. For each message, extract keys via `inboundKeys()` and compute `payload_sha256`.
  3. Insert into `customs_inbox` with `received_at: now()`, `organization_id: null` (unrouted yet).
  4. Route each row: resolve `company_key` to `organization_id`; resolve `tripNumber` or
     `cargoControlNumber` to `customs_submission_id` and thence to `movement_id` via
     `customs_submissions.movement_id`; update the row or write `processing_error`.
  5. For each successfully routed message, call `applyStatusMessage(parsed, orgId, movementId)`.

### Confirmed protocol facts

From the ACE/ACI response PDFs and BorderConnect's vendor-supplied JSON Schemas:

- Outbound `operation` field: `CREATE` for a new trip (initial filing), `UPDATE` for an existing
  trip already on file. Both can have `autoSend: true` to transmit immediately. Both
  **confirmed in PDF reference**.
- Inbound ACE status: arrives in `ACE_RESPONSE.processingResponse` (when shipments are accepted),
  `validationResponses[]` (rejections), `tripStatus` (AAD/RTR/HTR/RCO), and `shipmentStatusList[]`
  (02/05/1C/1D/1G/1H/11/12/13/19 codes per the CBP eManifest spec).
- Inbound `API_RESPONSE`: echoes the `sendId` from the upload. Subsequent `ACE_RESPONSE` and
  `ACI_RESPONSE` do not echo `sendId`.
- `GET /api/receive` success response shape: **undocumented**. The transport normalises defensively
  (array vs. single object vs. nested messages) and this must be confirmed with a live smoke script
  (Task 16) against BorderConnect's sandbox before mode is enabled for a real organization.

### Amend / cancel

- Amend: full re-upload of the trip body with `operation: UPDATE, autoSend: true`. BorderConnect
  applies the new shipment list and replaces the old. Shipment control numbers must match — a
  change to control numbers is a cancel + file-new cycle, not an amend.
- Cancel: `ACE_SEND_REQUEST` with `type: CANCEL_TRIP_AND_SHIPMENTS` (ACE) or `ACI_SEND_REQUEST`
  with `type: CANCEL, bundleTripAndShipments: true` (ACI). No trip body required (cancel does not
  need shipment details).

### RNS / SYSTEM_ALERT

- `RNS_SHIPMENT` messages (Release Notification System — CBP release notifications):
  parsed as an inbound customs event (`released`, with `releaseCode`, `releaseName`, `officeCode`).
  No `tripNumber` or `cargoControlNumber` link is provided — Task 11 (RNS integration) handles
  matching by shipment control number in the payload.
- `SYSTEM_ALERT` messages (BorderConnect service notices): parsed as `kind: "alert"` with a message
  string. No customs event correlation — logged and stored in `customs_inbox` for audit.

### Readiness

- A new `crossingReadiness()` function (Task 11) computes readiness per crossing by checking:
  - RNS received (`customs_inbox.data_type = 'RNS_SHIPMENT'` + processed + released).
  - `PARS_MATCHED` / `PARS_NOT_MATCHED` / `CSA_REPORTED` events on shipments.
  - `entry_on_file` + no holds for ACE; `accepted` + no holds for ACI.
  - Rolling 7-day average of decision time for forecast.

### WebSocket listener (hosting deferred)

- A separate app `apps/borderconnect-listener/` (Node.js/Fastify + `ws` client):
  - Opens a persistent WebSocket to BorderConnect's `/api/sockets/[suffix]` with the same
    `Api-Key` auth.
  - On each message, writes to `customs_inbox` (bypassing the HTTP drain).
  - Runs on dedicated infrastructure; enqueues a `customs.borderconnect_drain` job if the socket
    closes, to catch up any messages missed.
  - Hosting and config for this app are deferred (out of scope for Tasks 1–15).

## Data flow

**Transmit:**
`transmitMovement` (unchanged) → `client.transmit(manifest)` → one `POST /api/send/[suffix]` with
an `autoSend: true` `ACE_TRIP`/`ACI_TRIP`. `recordSubmission` (unchanged) stores the ack with
`mode: "border_connect"`.

**Inbox drain (`customs.borderconnect_drain` cron job, global, every minute — replaces per-movement polling):**

1. HTTP GET `/api/receive/[suffix]` drains every message currently queued for the service-provider account.
2. For each message:
   a. Extract routing keys via `inboundKeys()`: `companyKey`, `sendId`, `tripNumber`,
   `cargoControlNumber`, `shipmentControlNumber`.
   b. Compute `payload_sha256` and INSERT into `customs_inbox` (dedup on hash).
   c. Route by `companyKey → organizations.border_connect_company_key` to find `organization_id`.
   d. Route by `tripNumber` or `cargoControlNumber` to find `customs_submission_id` and
   `movement_id`.
   e. UPDATE the `customs_inbox` row with `organization_id`, `customs_submission_id`, `movement_id`,
   `processed_at: now()`.
   f. If unroutable (missing `companyKey` mapping or no matching submission), write
   `processing_error` and leave `organization_id` null.
3. For each successfully routed message, call `parseInbound()` and `applyStatusMessage()` exactly
   as today — no difference from `mock`/`gateway` in how status events are recorded.

**Amend / cancel:** as in "Chosen architecture" above; `transmitAmendment`/`cancelAtCustoms`
(unchanged) call `client.amend`/`client.cancel`, which are two-message and one-message send-only
operations respectively.

## Schema change

One migration (0047):

- `organizations`: add `border_connect_company_key text unique nullable` with a CHECK constraint.
- `trucks`: add `truck_type text not null default 'TR'` (BorderConnect/CBP conveyance code,
  validated with a CHECK regex).
- `integration_configs.mode` and `customs_submissions.mode`: widen the enum to add
  `"border_connect"` alongside `"mock"`/`"gateway"`.
- `customs_inbox` table (new, grain: one inbound BorderConnect message):
  - `id bigserial primary key`
  - `organization_id uuid nullable references organizations(id) on delete cascade` (resolved during routing)
  - `provider text not null default 'border_connect'` (enum: just border_connect for now)
  - `company_key text` (echoed from the message)
  - `data_type text not null` (the message's `data` field: API_RESPONSE, ACE_RESPONSE, etc.)
  - `send_id text` (echoed on API_RESPONSE only)
  - `trip_number`, `cargo_control_number`, `shipment_control_number text` (routing keys)
  - `payload jsonb not null` (the full message)
  - `payload_sha256 text not null unique` (dedup on retries)
  - `received_at timestamptz default now()` (when BorderConnect queued it)
  - `processed_at timestamptz` (when drain job processed it)
  - `processing_error text` (if routing failed)
  - `movement_id uuid nullable references movements(id, organization_id) on delete set null`
  - `customs_submission_id uuid nullable references customs_submissions(id, organization_id) on delete set null`
  - Indexes: `(id) where processed_at is null` (drain query), `(organization_id, received_at desc)`
    (Settings inbox list)
  - RLS: authenticated read where `organization_id is not null and has_permission(...)`;
    service role unrestricted.
- `background_jobs` policy: add `customs.borderconnect_drain` as job_type, enqueued only by the
  service role (no authenticated user can enqueue it).

Mirrored in `packages/db/src/schema/` per the usual migration → schema → `db reset`
→ `verify:mirror` → `db:lint` → `test:integration` sequence.

## Wiring

- `packages/integrations/src/customs/index.ts`: `createCustomsClient` gains a `border_connect`
  branch calling `createBorderConnectCustomsClient`, alongside the existing `mock`/`gateway`
  branches. Exports: `createBorderConnectCustomsClient`, `createBorderConnectHttpTransport`,
  `normaliseReceiveBody`, `parseInbound`, `inboundKeys`, `toAceTrip`, `toAciTrip`,
  `toCancelSendRequest`, and type exports.
- `packages/api/src/services/customs.ts`:
  - `customsClientFor`: when `mode === "border_connect"`, read `organizations.border_connect_company_key`
    and pass `{apiUrlSuffix: process.env.BORDERCONNECT_API_URL_SUFFIX, apiKey: process.env.BORDERCONNECT_API_KEY,
companyKey}` to the client. Fail with `PRECONDITION_FAILED` in production if `companyKey` is
    not set.
  - `scheduleDecision`: for `border_connect` clients, do nothing (status arrives through the
    inbox drain, not per-movement polling).
  - `applyStatusMessage`: unchanged — branches on `status.status` and `decision` fields, which
    are populated the same way for all three modes.
- `packages/api/src/services/borderconnect.ts` (new): `drainAndApplyCustomsInbox()`
  implementing steps 1–5 of the inbox drain above. Called by the cron route.
- `packages/api/src/services/jobs.ts`: `customs.borderconnect_drain` job type, callable only by
  service role, with no organization-specific payload (global drain per service-provider account).
- `packages/api/src/router/integrations.ts`: `mode` enum becomes `["mock", "gateway", "border_connect"]`;
  when `mode === "border_connect"` is selected, force `baseUrl: null` server-side (not exposed
  to the client).
- `apps/web/src/app/api/jobs/borderconnect-drain/route.ts` (new): Vercel cron endpoint
  enqueuing `customs.borderconnect_drain` with the service role.
- `apps/web/vercel.json`: cron config scheduling the route every minute.

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

1. `GET /api/receive` response shape when messages are pending (array vs. single object vs.
   nested in a wrapper) — undocumented, needs a live smoke script (Task 16) against BorderConnect's
   sandbox.
2. ACI `AMEND` with `autoSend: true` and amendment reason codes — the ACI PDF PDFs list update
   reason codes but don't confirm they are valid with autoSend + UPDATE operation. Confirmed via
   test when implemented.
3. `time-zones.json` endpoint and values — fetch during Task 4 to check if the codes match IANA
   names (to decide whether to send `estimatedArrivalTimeZone` on ACE trips). If not IANA, omit
   the field and document the list in the README.
4. ACE hazmat `emergencyContact` field and in-bond `irsNumber`/`fda` fields — BorderConnect
   requires these but `ManifestPayload` does not capture them. v1 throws 422 listing them as
   missing; they are deferred to v2.
5. `companyKey` length: BorderConnect's PDFs document it as max 30 chars; a sample in the live
   docs is 32 chars. Do not hard-validate; rely on BorderConnect's rejection if oversized.
6. Error-code spelling: BorderConnect may return `"FAILED"` vs. `"FAILURE"` inconsistently. The
   transport parser accepts both.
7. WebSocket vs. HTTP queue diversion: unknown whether an open persistent WebSocket connection
   diverts messages away from the HTTP `GET /api/receive` queue or if both are fed in parallel.
   Task 16's smoke script does not test this; it is a known open question for the WebSocket
   listener (Task 15, hosting deferred).
