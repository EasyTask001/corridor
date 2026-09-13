# BorderConnect transport

`transport.ts` is the only vendor-specific file so far for the BorderConnect
eManifest API: how bytes reach it. No ACE/ACI mapping lives here yet (see
`../gateway/` for the shape that mapping will eventually mirror) — that's a
later task.

`createBorderConnectHttpTransport()` mirrors `../gateway/transport.ts`'s
retry/timeout/error conventions (`CustomsTransportError`, `retryable = 429 ||

> = 500`, an `AbortController` with a configurable deadline) against
> BorderConnect's own wire protocol, which differs from the gateway's:

- Auth is an `Api-Key` header, not `Authorization: Bearer`.
- The URL shape is fixed per company, not a configurable REST path per call:
  `POST /api/send/{apiUrlSuffix}` to file a message, `GET /api/receive/{apiUrlSuffix}`
  to poll for queued inbound messages. `baseUrl` defaults to
  `https://borderconnect.com`.
- BorderConnect spells its failure status two ways across message types
  (`"FAILURE"` and `"FAILED"`); both are treated as a failed call.
- `receive()` bodies show up in several documented shapes — already an
  array, `null`/`""` when the queue is empty, a `{messages: [...]}`
  envelope, or a single message object (identified by a `data` field) that
  isn't wrapped in an array at all. `normaliseReceiveBody()` collapses all of
  these to `Record<string, unknown>[]`.

## No vendored JSON Schemas

BorderConnect does not publish machine-readable JSON Schemas for its message
types (the `*-schema.json` URLs referenced in early design notes 404 — they
soft-404 to BorderConnect's own HTML error page under an HTTP 200/302, not a
real JSON document). Correctness for the ACE/ACI mappers is enforced by
direct field/regex assertions against the documented PDF manuals (`ace.ts`,
`aci.ts`, `validate.ts`), not schema validation, verified with full-object
`toEqual` tests (`ace.test.ts`, `aci.test.ts`).

## Outbound mapping (`format.ts`, `code-lists.ts`, `validate.ts`, `ace.ts`,

`aci.ts`, `send-request.ts`)

`toAceTrip`/`toAciTrip` turn a `ManifestPayload` into the `ACE_TRIP`/
`ACI_TRIP` send-request bodies BorderConnect's send API expects.
`validateForBorderConnect` runs first and collects every unmet requirement
into one list; the mappers throw a single 422 `CustomsTransportError` naming
all of them, never one throw per problem.

`code-lists.ts` vendors eight `https://borderconnect.com/data/**` endpoints
(confirmed real by curling and inspecting each one — distinct from the
schema URLs above, which don't exist) as `as const` arrays, each with its
source URL in a comment. There is no live fetch at import/call time: these
lists rarely change, and depending on a network call would make every test
(and any borderconnect.com outage) a transport failure.

### Time zones

`https://borderconnect.com/data/time-zones.json` returns US time-zone
_abbreviations_ (`PST`/`AST`/`CST`/`EST`/`MST`), not IANA zone names. Since
Corridor stores an IANA name (`organizations.timezone`, e.g.
`America/Toronto`) and has no reliable way to turn that into one of these
five abbreviations for every zone Corridor's carriers operate in, `bcDateTime`
computes the wall-clock string via `Intl.DateTimeFormat` in the IANA zone and
never emits a separate `estimatedArrivalTimeZone` field.

### Known gaps / judgment calls (task 5)

- **Trailer type mapping** (`TRAILER_TYPE_MAP`): only Corridor `equipment_
types.code` values with an identically-coded, identically-described
  BorderConnect `trailer-types.json` entry are mapped (~20 of ~60 Corridor
  codes). Codes with no confident match (tank sub-types split differently,
  vans, generic containers, …) 422 rather than guess.
- **Driver document types** (`DRIVER_DOCUMENT_TYPE_MAP`): `fast` has no
  BorderConnect travel-document code at all (a FAST card still reaches
  BorderConnect via `fastCardNumber`, matched by its CBP-format regex).
  `permanent_resident_card` and `us_alien_registration` each have _two_
  candidate BorderConnect codes (a C1/A1 vs. C2/A2 split) with nothing in
  Corridor's data to disambiguate — both are left unmapped rather than
  guessed.
- **ACE shipment type table**: only `regular_bill`→`PAPS`,
  `goods_astray`→`GOODS_ASTRAY` and `in_bond`→`IN_BOND` are mapped, per the
  plan's explicit "until confirmed" instruction — even though
  `BC_ACE_SHIPMENT_TYPES` has plausible-looking entries for the other
  Corridor values (`ATTACHED_CF7523`, `ATTACHED_CF3311`, `ATTACHED_CF3299`),
  those pairings aren't confirmed against the manual.
- **Commodity `value`**: BorderConnect's exact commodity-value field shape
  isn't documented in the task-5 brief; it's mapped as `{amount, currency}`
  (unchanged from `ManifestPayload`) rather than guessing a different shape.
- **`instrumentsOfInternationalTrafficBond`** is a **top-level `ACE_TRIP`
  field**, computed once from `m.trip.iitIndicator` — never attached to a
  nested `ACE_SHIPMENT`. (The task-5 brief's wording listed this rule under
  the "ACE shipments" bullet, which read as per-shipment; that was corrected
  during code review against BorderConnect's real ACE_TRIP reference, and the
  master plan's ruling was updated to match. `iitIndicator` is already a
  trip-scoped field in `ManifestPayload`, consistent with the corrected
  placement.)

## Inbound parsing (`inbound.ts`)

`parseInbound(msg)` turns one message off the shared queue (`GET
/api/receive`, drained by a later task's `customs.borderconnect_drain`) into
a normalised, typed `BorderConnectInbound`. It never throws — a message this
adapter doesn't recognize, or that isn't shaped like an object, comes back as
`kind: "unknown"` rather than crashing the drain job. `inboundKeys(msg)` pulls
the routing keys (`companyKey`, `sendId`, `tripNumber`,
`cargoControlNumber`/`shipmentControlNumber`) the drain job needs to resolve
`organization_id` and `customs_submission_id`/`movement_id` _before_
`parseInbound` runs, also without throwing.

`ACE_RESPONSE`/`ACI_RESPONSE`/`ACI_NOTICE` all become `kind: "customs_status"`
carrying the same `CustomsStatusMessage` shape `gateway/mapping.ts`'s
`fromGatewayStatus` produces, so the rest of Corridor applies a BorderConnect
status update exactly like a gateway one.

## The `CustomsClient` adapter (`client.ts`)

`createBorderConnectCustomsClient` wraps everything above behind the same
`CustomsClient` interface `mock` and `gateway` already implement, so the rest
of Corridor (movement transmit/amend/cancel, the readiness panel, …) can use
BorderConnect as a third mode without knowing its wire protocol.
`createCustomsClient({ mode: "border_connect", ... })` (`../index.ts`)
resolves to it.

### Mode selection / env vars

| Input          | Source                                                               | Notes                                                                                         |
| -------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apiUrlSuffix` | `BORDERCONNECT_API_URL_SUFFIX`                                       | One Service Provider account for all of Corridor — shared across every tenant.                |
| `apiKey`       | `BORDERCONNECT_API_KEY`                                              | Same account-wide key.                                                                        |
| `companyKey`   | `organizations.border_connect_company_key`                           | Per-tenant — BorderConnect's way of telling one carrier's messages apart on a shared account. |
| `tenantKey`    | the organization id                                                  | Never sent over the wire; scopes the fixture queue only.                                      |
| `environment`  | `integration_configs.environment` (per org, Settings → Organization) | Gates `live` — see below.                                                                     |

`live = isBorderConnectLive({ environment, apiUrlSuffix, apiKey })`, i.e.
`environment === "production"` **and** both env vars set. The account-wide
`apiUrlSuffix`/`apiKey` are deployment-wide, but `environment` is per-org, so
an org left at the sandbox default never goes live no matter what the
deployment's env vars say — a sandbox org must never file a real ACE/ACI trip
with CBP/CBSA just because some other org's BorderConnect account is
configured. With `live` true, `transmit`/`amend`/`cancel` go over
`createBorderConnectHttpTransport` (`transport.ts`); otherwise they replay
`createFixtureBorderConnectTransport` instead — every test in `client.test.ts`
runs with **no credentials**, per the repo-wide rule that every external
service degrades to a deterministic mock/fixture when its env var is unset. A
caller may also inject its own `transport` (what every test above the
fixture-replay-specific ones does), which always wins over both.

The drain receives an explicit deployment environment. Production jobs require
the live account credentials and an encrypted `BORDERCONNECT_SPOOL_DIR` /
`BORDERCONNECT_SPOOL_KEY`; sandbox jobs always use the fixture queue, even when
the deployment has a live account configured. The encrypted spool is written
before a pop-on-read receive batch is inserted into `customs_inbox` and is
removed only after the insert commits, so a database outage stops the receive
loop without losing the provider batch. Use a persistent 0700 volume for the
spool in production.

A **live** client refuses to `transmit`/`amend`/`cancel` with `companyKey:
null` (a 422 `CustomsTransportError` — there is no tenant to attribute the
filing to on a shared account). The **fixture** transport doesn't care whose
key it is, so a null `companyKey` there is filled in with a harmless
`"fixture"` placeholder rather than blocking the test/demo path.

### Message flow

```
transmit/amend  ──▶  toAceTrip/toAciTrip  ──▶  POST /api/send/{suffix}  (ACE_TRIP / ACI_TRIP)
cancel           ──▶  toCancelSendRequest  ──▶  POST /api/send/{suffix}  (ACE_SEND_REQUEST / ACI_SEND_REQUEST)
                                                        │
                                                        ▼
                                         (async, no synchronous decision)
                                                        │
                                                        ▼
GET /api/receive/{suffix}  ◀── shared inbox ◀── API_RESPONSE (IMPORTED/TRANSMITTED/…)
                                             ◀── ACE_RESPONSE | ACI_RESPONSE | ACI_NOTICE
                                             ◀── RNS_SHIPMENT | SYSTEM_ALERT
```

BorderConnect never answers `send` with a decision — only an ack that the
message reached its queue. The real accepted/held/rejected/released answer
always arrives later, through the same shared inbox every tenant's messages
land in, keyed back to the sender by `companyKey`/`sendId`/`tripNumber`. That
is why `fetchStatus`, `fetchDecision`, `fetchNotices` and every `inBond*`
method on this client throw a 501 `CustomsTransportError` naming themselves
and pointing at the inbox — there is no request/response round trip to serve
them from in this mode. `parseInbound` returns `null` for the same reason:
there is no signed webhook to verify here (a later task drains the inbox
directly with `parseInbound`/`inboundKeys` from `inbound.ts`).

`ping()` calls `transport.receive()` and reports how many messages were
waiting — **never call it in production**, since it drains the same queue
the inbox-drain job needs. It exists for the fixture path and this module's
tests; a later task points the Settings "Test connection" button at the
drain job instead.

### Fixture replay (`createFixtureBorderConnectTransport`)

With no live credentials (or when a test injects one directly),
`send()` drops the outbound message into a per-tenant queue
(`borderConnectQueue`, `../fixture-state.ts`) and immediately enqueues the
canned inbound replies a real crossing would eventually push back:

1. An `API_RESPONSE` ack — `IMPORTED` for a trip (`ACE_TRIP`/`ACI_TRIP`),
   `TRANSMITTED` for a cancel send-request (`ACE_SEND_REQUEST`/
   `ACI_SEND_REQUEST`).
2. For a trip only, the regime's outcome fixture
   (`fixtures/outcomes/<regime>-<outcome>.json`), keyed on the same
   control-number-suffix convention `gateway/client.ts`'s `fixtureOutcomeFor`
   uses (reused here, not reimplemented):

   | First shipment's control number ends in | Outcome  | ACE file enqueued                                           | ACI file enqueued                                                                                                                                                                              |
   | --------------------------------------- | -------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `H`                                     | held     | `ace-held.json` (`ACE_RESPONSE`, `tripStatus: "HTR"`)       | `aci-held.json` (`ACI_NOTICE`, `type: "INSUFFICIENT_REVIEW_TIME_WARNING"` — ACI has no `ACE`-style "held" trip status, so the closest documented CBSA signal for "still under review" is used) |
   | `R`                                     | rejected | `ace-rejected.json` (`ACE_RESPONSE`, `validationResponses`) | `aci-rejected.json` (`ACI_RESPONSE`, `type: "REJECT"`, `errorResponses`)                                                                                                                       |
   | anything else                           | accepted | `ace-accepted.json` (`ACE_RESPONSE`, `processingResponse`)  | `aci-accepted.json` (`ACI_RESPONSE`, `type: "ACCEPT"`)                                                                                                                                         |

   The control number is read straight off the built send-request body
   (`shipmentControlNumber` for an `ACE_SHIPMENT`, `cargoControlNumber` for an
   `ACI_SHIPMENT`), not off the `ManifestPayload` — the fixture transport only
   ever sees the wire body, matching what a real send would see.

Every enqueued message is stamped with the _sent_ `companyKey`, `sendId` and
`tripNumber`, so a test (or a future drain-job test) can correlate a queued
reply back to the request that produced it. `receive()` drains the queue —
same "poll and consume" shape a real `GET /api/receive` call has, just
in-process and instant.

## Open risks carried into this task (from Task 1's plan)

These are unresolved by design — this task wraps the existing outbound/inbound
mapping behind `CustomsClient`, it doesn't resolve BorderConnect protocol
ambiguities. See `docs/superpowers/plans/2026-09-12-borderconnect-service-provider.md`
("Open risks carried into implementation") for the full list; the ones most
relevant here:

1. **`GET /api/receive` envelope** is still unconfirmed against a live account
   — `normaliseReceiveBody` (`transport.ts`) defensively handles four shapes.
   `scripts/borderconnect-smoke.ts` (Task 16) exists and is ready to settle
   this for either ACE or ACI (loads a private environment, files a minimal
   manifest with `autoSend: false`, and records only redacted envelope shape,
   status, routing-key hashes, and timestamps), but **it has not been run against
   the live account yet**. The smoke script requires
   `BORDERCONNECT_API_URL_SUFFIX`, `BORDERCONNECT_API_KEY`, and
   `BORDERCONNECT_TEST_COMPANY_KEY` from a private environment and correctly
   refuses to run when any is absent rather than guessing an account value.
   **This risk remains open**: someone with access to the approved
   BorderConnect Service Provider test account must provision those secrets
   outside Git and re-run
   `pnpm --filter @corridor/integrations smoke:borderconnect`. Note that
   settling the envelope specifically needs the receive half, which is now
   behind an explicit `--drain-shared-queue` flag (safety rail #4 in the
   script's header): `GET /api/receive` is pop-on-read with no replay, so
   polling a live account with real tenants filing through it would destroy
   their pending messages. Run it only against an account nobody is filing
   through, or with the drain job and the listener stopped.
2. **ACI amendments**: the production capability is disabled by default and
   both the server procedure and client return a precondition failure. Keep
   `BORDERCONNECT_ACI_AMEND_ENABLED=false` until BorderConnect supplies a
   written sequence and a live CBSA amendment round trip is captured through
   Corridor.
3. **`companyKey` length** — the live contract matrix and tenant schema now
   enforce BorderConnect's documented 30-character maximum. A null key is
   rejected before a live send so a shared Service Provider account can never
   produce an unattributable filing.
4. Hazmat `emergencyContact` and in-bond `irsNumber`/`fda` are still not
   captured anywhere in the outbound mapping (`validate.ts` 422s those
   shipments) — unaffected by this task, carried forward as-is.
5. **Multi-trailer `loadedOn` (0051)**: the field is implemented and unit
   tested against the manuals, but has never been sent to the live account.
   The production capability is disabled by default
   (`BORDERCONNECT_MULTI_TRAILER_ENABLED=false`) whenever more than one
   trailer is attached; a single trailer or bobtail manifest is unaffected
   and has always been byte-identical (no `loadedOn` key is emitted unless a
   filer explicitly chooses a unit). Keep the flag off until a live
   BorderConnect round trip with a double confirms the field is accepted.
