# BorderConnect live validation

This is the step-by-step procedure for the live evidence gates in
`docs/operations/customs-production-runbook.md`'s "Deployment gates" section:
one real ACE and one real ACI original-filing round trip, amend/cancel,
rejection, unroutable-message, empty-trip, and multi-trailer scenarios. It is
a runbook, not automated tests — the tests in this repository (`ace.test.ts`,
`aci.test.ts`, `filing-matrix.test.ts`, `contract.test.ts`, …) prove the
mapping logic against the documented wire format; only a real filing proves
BorderConnect and CBP/CBSA actually accept it.

You need the approved Service Provider test account's `BORDERCONNECT_API_URL_SUFFIX`,
`BORDERCONNECT_API_KEY`, and `BORDERCONNECT_TEST_COMPANY_KEY` in `.env.local`
before starting. Confirm `BORDERCONNECT_SMOKE_AUTOSEND` is **not** set in your
shell or `.env.local` — the smoke script refuses to run at all if it is (see
its own header for why).

## 1. Outbound smoke, both regimes

```bash
source .env.local
pnpm --filter @corridor/integrations smoke:borderconnect -- --regime=ACE
pnpm --filter @corridor/integrations smoke:borderconnect -- --regime=ACI
```

`autoSend` is hard-coded `false` in the script and cannot be overridden —
BorderConnect holds these in its own system without transmitting to CBP/CBSA.
This confirms the outbound mapping and the send half of the transport against
the real API before anything below touches the shared receive queue. Evidence
lands in `artifacts/borderconnect-smoke/` (gitignored) — do not commit it.

## 2. Receive envelope + fixture capture

Only against an account no tenant is filing through, or with the drain job
and the `borderconnect-listener` process stopped — `GET /api/receive` is
pop-on-read with no replay, and the queue is shared across every tenant on
the account:

```bash
pnpm --filter @corridor/integrations smoke:borderconnect -- \
  --regime=ACE --drain-shared-queue --record-fixtures=artifacts/borderconnect-smoke/fixtures
pnpm --filter @corridor/integrations smoke:borderconnect -- \
  --regime=ACI --drain-shared-queue --record-fixtures=artifacts/borderconnect-smoke/fixtures
```

This confirms `normaliseReceiveBody()` handles whatever envelope shape the
account actually returns, and writes one sanitized fixture candidate per
received message to the `--record-fixtures` directory.

## 3. Review and promote fixtures

Open each file `--record-fixtures` wrote. Confirm nothing besides the
allow-listed structural fields and canonical identifiers survived
sanitization (`sanitizeInboundForFixture()`,
`packages/integrations/src/customs/borderconnect/sanitize.ts`) — then copy
the ones worth keeping as regression fixtures into
`fixtures/inbound/live/<yyyy-mm-dd>-<kind>.json`, with a sidecar
`<same-name>.expected.json` recording what `parseInbound()` should produce
(see that directory's own `README.md` for the exact shape).
`pnpm --filter @corridor/integrations test inbound.live-fixtures` picks up
every promoted pair automatically.

## 4. Cleanup

```bash
pnpm --filter @corridor/integrations smoke:borderconnect -- --regime=ACE --cleanup
pnpm --filter @corridor/integrations smoke:borderconnect -- --regime=ACI --cleanup
```

Sends a `DELETE` for the smoke trip so it does not linger in BorderConnect's
own system indefinitely.

## 5. Real filings through Corridor

Only after steps 1–4 pass. These go through the actual product, not the
smoke script — create the movement in Corridor's UI or via a seeded fixture,
and record each result per `docs/operations/evidence/TEMPLATE-borderconnect-live.md`:

1. **One real ACE original filing**: create → validate → transmit → provider
   acknowledgement → government response → inbox persistence → tenant
   routing → application timeline, end to end inside Corridor.
2. **One real ACI original filing**, same round trip.
3. **ACE amend** on a previously accepted filing.
4. **ACE cancel**.
5. **One rejection** — a filing CBP/CBSA actually refuses (an invalid HS
   code or missing required field is the easiest way to get a real one
   without risking a legitimate crossing).
6. **One unroutable message** — confirm the drain marks a message with no
   matching `customs_submission` as `unrouted` rather than misapplying it
   (see `docs/security-review.md` §8 for the routing contract this checks).
7. **One empty trip** (`isEmpty: true`, no `shipments`) — neither the ACE nor
   ACI manual documents an explicit empty indicator, so this is the one
   filing shape whose wire behaviour is entirely unverified without a live
   run. Confirms `BORDERCONNECT_EMPTY_TRIP_ENABLED` is safe to enable.
8. **One two-trailer trip with an explicit `loadedOn`**:
   ```bash
   pnpm --filter @corridor/integrations smoke:borderconnect -- --regime=ACE --two-trailers
   ```
   validates the field before `BORDERCONNECT_MULTI_TRAILER_ENABLED` can go on
   in production (0051) — confirm the accepted filing's stored outbound
   payload actually carries `loadedOn` on every ACE commodity (or the ACI
   shipment), matching `ace.test.ts`/`aci.test.ts`'s fan-out assertions.

## 6. Record and flip the flags

Write the evidence record (step 5's template). If it passed:

- Multi-trailer validated → set `BORDERCONNECT_MULTI_TRAILER_ENABLED=true` in
  the production environment and update the "Feature truth and GA gates"
  section of `docs/operations/customs-production-runbook.md` and
  `docs/operations/supported-filing-matrix.md`.
- Empty trip validated → same, for `BORDERCONNECT_EMPTY_TRIP_ENABLED`.
- Link the evidence record from the pilot log.

## Related

- `docs/operations/customs-production-runbook.md` — the "WebSocket test
  window" section covers the same shared-queue caution for the standalone
  `apps/borderconnect-listener` process; never run it and a
  `--drain-shared-queue` smoke pass at the same time.
- `packages/integrations/src/customs/borderconnect/README.md` — the adapter's
  own reference for the wire contract and manual versions.
