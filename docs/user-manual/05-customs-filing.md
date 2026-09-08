# Customs filing

## Modes

Under Settings → Integrations each regime runs in **mock** mode (a deterministic simulator, the default with no credentials) or **gateway** mode (a certified EDI gateway's API, with a base URL and API key). **Test connection** checks the gateway.

## What happens on transmit

1. The manifest is validated one last time.
2. It is sent; the submission and its correlation id are recorded.
3. A decision is polled for, or arrives by webhook. Statuses cascade to the shipments.
4. Every event lands on the movement timeline and in the transmission log.

## Amendments and cancellations

An accepted manifest can be amended (re-transmitted with the differences and, for ACI, a CBSA reason code) or cancelled. A rejected one becomes editable.

## Carrier notices

Notices the gateway publishes for your carrier codes are synced hourly and shown under Integrations.
