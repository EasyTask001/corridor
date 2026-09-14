# Live BorderConnect fixtures

This directory starts empty. Each file here is a real BorderConnect inbound
message, sanitized by `sanitizeInboundForFixture()`
(`packages/integrations/src/customs/borderconnect/sanitize.ts`) and promoted
by a human from a `--record-fixtures` run of `borderconnect-smoke.ts` — see
`docs/operations/borderconnect-live-validation.md` for the full procedure.

## File pairs

Each promoted message is two files sharing a basename:

- `<yyyy-mm-dd>-<kind>.json` — the sanitized message itself.
- `<yyyy-mm-dd>-<kind>.expected.json` — what `parseInbound()` should produce
  for it, written by the human who reviewed the sanitized output. At minimum:

  ```json
  { "kind": "customs_status", "status": { "status": "released" } }
  ```

  `inbound.live-fixtures.test.ts` loads every `*.json` file that is not
  itself an `.expected.json`, requires a matching sidecar, and asserts
  `parseInbound(message)` matches the sidecar with `toMatchObject` — the
  sidecar only needs the fields worth pinning, not every field on the parsed
  result.

## Before adding a file here

Read the sanitized JSON yourself first. `sanitizeInboundForFixture()` keeps
structural fields (message type, status codes, dates shifted to a fixed
epoch) and canonical identifiers, and redacts everything else to
`<redacted:len=N>` — but a human review catches anything the allow-list
missed before it lands in this repository's git history.
