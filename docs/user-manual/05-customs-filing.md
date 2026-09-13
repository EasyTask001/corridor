# Customs filing

## Modes

Under Settings → Integrations each regime runs in **mock** mode (a deterministic simulator, the default with no credentials), **gateway** mode (a certified EDI gateway's API, with a base URL and API key), or **BorderConnect** mode (BorderConnect's Service Provider eManifest API — set your BorderConnect company key on Settings → Organization; the API URL and key are account-wide, configured once for all tenants). **Test connection** checks the gateway; in BorderConnect mode it drains the shared inbox instead ("Check inbox").

## What happens on transmit

1. The manifest is validated one last time.
2. It is sent; the submission and its correlation id are recorded.
3. A decision is polled for, or arrives by webhook. Statuses cascade to the shipments.
4. Every event lands on the movement timeline and in the transmission log.

## Amendments and cancellations

An accepted ACE manifest can be amended (re-transmitted with the differences) or cancelled. ACE cancellation and ACI cancellation are both available once your BorderConnect company key is configured. **ACI amendment is not available in production yet** — it stays off until a live CBSA amendment round trip is validated, and no CBSA reason code is transmitted today even in modes where amendment is enabled. A rejected manifest becomes editable.

Multiple trailers and a declared-empty trip are similarly held behind a
production flag until a live BorderConnect round trip validates them; see
`docs/operations/supported-filing-matrix.md` for the full list of what is
supported, gated, or refused today.

## Carrier notices

Notices the gateway publishes for your carrier codes are synced hourly and shown under Integrations.
