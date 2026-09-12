# BorderConnect transport

`transport.ts` is the only vendor-specific file so far for the BorderConnect
eManifest API: how bytes reach it. No ACE/ACI mapping lives here yet (see
`../gateway/` for the shape that mapping will eventually mirror) — that's a
later task.

`createBorderConnectHttpTransport()` mirrors `../gateway/transport.ts`'s
retry/timeout/error conventions (`CustomsTransportError`, `retryable = 429 ||
>= 500`, an `AbortController` with a configurable deadline) against
BorderConnect's own wire protocol, which differs from the gateway's:

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
*abbreviations* (`PST`/`AST`/`CST`/`EST`/`MST`), not IANA zone names. Since
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
  `permanent_resident_card` and `us_alien_registration` each have *two*
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
