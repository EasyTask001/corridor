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
real JSON document). Correctness for the ACE/ACI mappers (a later task) is
enforced by direct field/regex assertions against the documented PDF
manuals, not schema validation.
