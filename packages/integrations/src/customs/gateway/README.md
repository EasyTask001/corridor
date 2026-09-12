# Customs gateway client

`createGatewayCustomsClient()` files manifests through a certified EDI gateway's
REST API behind the same `CustomsClient` interface the mock implements. The
vendor-specific parts are isolated in two small files:

- `transport.ts` — bytes on the wire: base URL, `Authorization: Bearer <apiKey>`,
  30 s deadline, `CustomsTransportError` on non-2xx (retryable for 429 / 5xx).
- `mapping.ts` — the provider-neutral contract and the wire ↔ domain shapes:

| Call                               | Purpose                              |
| ---------------------------------- | ------------------------------------ |
| `POST /manifests`                  | original filing → reference number   |
| `POST /manifests/{ref}/amendments` | amendment (re-files under a new ref) |
| `POST /manifests/{ref}/cancel`     | cancellation                         |
| `GET /manifests/{ref}`             | status document (decision + events)  |
| `GET /manifests/ping`              | connection test                      |
| `GET /notices?since=`              | carrier service notices              |

## Selecting the client

`createCustomsClient({ mode, … })` picks `mock` (today's deterministic gateway)
or `gateway`. `integration_configs.mode` holds the choice per organization and
provider; `base_url` and the Vault API key (or `CUSTOMS_GATEWAY_BASE_URL` /
`CUSTOMS_GATEWAY_API_KEY`) configure the HTTP transport.

## Fixture replay

In `gateway` mode with no base URL / API key the client replays the fixtures in
`fixtures/`, so the full transmit → poll → decision path runs offline (CI,
demos). The family is chosen by the **last character of the first shipment's
control number**:

| Suffix        | Fixture                   | Sequence                                 |
| ------------- | ------------------------- | ---------------------------------------- |
| `H`           | `{ace,aci}-held.json`     | accepted → held → released               |
| `R`           | `{ace,aci}-rejected.json` | rejected                                 |
| anything else | `{ace,aci}-accepted.json` | accepted → released (entry per shipment) |

Each fixture is a list of `stages`; the n-th poll of a reference returns the
n-th stage (the last one repeats). Events and shipment outcomes are templated
with the filing's control numbers and port, and entry numbers come from
`simulatedEntryNumber()` so they match the mock gateway's.

## Inbound webhook

`POST /api/webhooks/customs` receives the same status document with an
`eventId`. The body is authenticated with HMAC-SHA256 over the raw bytes using
`CUSTOMS_GATEWAY_WEBHOOK_SECRET`, hex in `X-Corridor-Signature`
(`inbound.ts`). The reference number resolves to the movement through
`customs_submissions`; `eventId` makes delivery idempotent.

## The other live mode: BorderConnect

`../borderconnect/` is a third `CustomsClient` mode, `border_connect` — a
different provider with a materially different shape: one shared Service
Provider account (not per-org base URL/API key), a poll-driven shared inbox
(not a signed inbound webhook), and message-oriented `POST /api/send` /
`GET /api/receive` (not one REST endpoint per operation). See
`../borderconnect/README.md` for its transport, mapping and inbound-parsing
conventions — they intentionally do not reuse this package's `transport.ts`/
`mapping.ts`, since BorderConnect's wire protocol doesn't fit this gateway's
shape.
