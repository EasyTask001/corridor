# BorderConnect live validation — [ACE|ACI] round trip

Copy this file to `borderconnect-live-<yyyy-mm-dd>.md`, delete this line, and
fill in every field. See `docs/operations/borderconnect-live-validation.md`
for the procedure this records.

## Summary

- **Date:**
- **Regime:** ACE / ACI
- **Account:** (test / production Service Provider account — never the
  account's API key or company key itself)
- **Verified by:**
- **Outcome:** pass / fail / partial

## What was exercised

Check off each scenario this record covers. One record may cover more than
one row if they were run in the same session.

- [ ] Original filing, full round trip: create → validate → transmit →
      provider acknowledgement → government response → inbox persistence →
      tenant routing → application timeline
- [ ] Amend
- [ ] Cancel
- [ ] Rejection (a filing CBP/CBSA actually refused, not a simulated one)
- [ ] Unroutable message (no matching `customs_submission` — confirms the
      drain marks it `unrouted` rather than misapplying it)
- [ ] Empty trip (`isEmpty: true`, `shipments` omitted)
- [ ] Two or more trailers with an explicit `loadedOn` value on every shipment
      (`--two-trailers`) — the live check `BORDERCONNECT_MULTI_TRAILER_ENABLED`
      is gated on

## Evidence

- **Smoke script run:** command line used, redacted evidence file path under
  `artifacts/borderconnect-smoke/` (never commit that file)
- **Fixture candidates reviewed:** which `--record-fixtures` outputs were
  promoted into `fixtures/inbound/live/`, and their filenames
- **Tenant-scoped UI screenshots or references:** where in Corridor's own UI
  the result was confirmed (movement id, submission id — not raw payloads)
- **Provider correlation:** trip number hash / sendId hash from the redacted
  evidence file, not the plaintext value

## Notes

Anything unexpected: a wire quirk the manuals didn't document, a validation
message that didn't match what `contract.ts` expected, timing that suggests
the pilot runbook's assumptions need revisiting.

## Follow-up

- [ ] If this validates multi-trailer `loadedOn`: update
      `BORDERCONNECT_MULTI_TRAILER_ENABLED` in the production environment and
      the "Feature truth and GA gates" section of
      `docs/operations/customs-production-runbook.md`
- [ ] If this validates the empty-trip wire behaviour: same, for
      `BORDERCONNECT_EMPTY_TRIP_ENABLED`
- [ ] Link this record from the pilot log
