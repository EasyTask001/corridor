# Supported filing matrix (BorderConnect)

The source of truth for this table is
`packages/integrations/src/customs/filing-matrix.test.ts` — an executable
test file, not this document. If the two ever disagree, the test is right;
update this table to match it, not the other way around.

| Scenario | Status | Enforced by | Evidence needed for GA |
| --- | --- | --- | --- |
| ACE standard PAPS shipment | ✅ Supported | — | Live ACE round trip |
| ACI standard PARS shipment | ✅ Supported | — | Live ACI round trip |
| Bobtail (no trailer) | ✅ Supported | — | Live round trip |
| Single trailer | ✅ Supported | `resolveLoadedOn` default (0051) | Live round trip |
| Two or more trailers, `loadedOn` set on every shipment | ⚠️ Gated | `BORDERCONNECT_MULTI_TRAILER_ENABLED` (off by default in production) | Live round trip with a double, `loadedOn` field confirmed accepted |
| Two or more trailers, `loadedOn` not set | ❌ Refused | `validateForBorderConnect` (ambiguous placement) | — (by design; the filer must choose) |
| Empty trip ("Empty Trailer" / "Empty Trip") | ⚠️ Gated | `BORDERCONNECT_EMPTY_TRIP_ENABLED` (off by default in production) | Live round trip; neither manual documents an explicit empty-trip wire field |
| ACE amendment | ✅ Supported once configured | — | Live amendment round trip |
| ACE cancellation | ✅ Supported once configured | — | Live cancellation round trip |
| ACI amendment | ❌ Disabled | `BORDERCONNECT_ACI_AMEND_ENABLED` (off by default) | `ACI_SEND_REQUEST type:"AMEND"` + `tripAmendmentReasonCode` is not implemented yet, in addition to needing a live round trip |
| ACI LVS / postal / flying-truck / in-transit / IIT trip flags | ❌ Refused | `validateForBorderConnect` ("not representable in the BorderConnect API") | — |
| ACE hazmat commodity | ❌ Refused | `validateForBorderConnect` (no emergency-contact capture) | Emergency-contact capture is not implemented |
| ACE in-bond shipment | ❌ Refused | `validateForBorderConnect` (no `irsNumber`/`fda` capture) | Not implemented |
| ACI plain non-PARS shipment | ❌ Refused | `validateForBorderConnect` (no confirmed BorderConnect shipment type) | Open risk — BorderConnect's exact type for this case is unconfirmed |
| QP In-Bond customs messaging | ❌ Tracking-only | `resolveCustomsCapabilities` (`inBond: false` in `border_connect` mode) | Not implemented — tracking only today |
| Provider status polling | ❌ Not applicable | `resolveCustomsCapabilities` (`status: false` in `border_connect` mode) | Status arrives through the shared BorderConnect inbox, not polling |

## Reading this table

- **Refused** means `validateForBorderConnect` rejects the manifest before
  it is ever sent — the adapter says "I don't know how to file this safely"
  rather than manufacture a customs value. This is by design, not a bug to
  fix quickly.
- **Gated** means the code path exists and is unit-tested, but is held
  behind a fail-closed production flag until a real BorderConnect round
  trip proves the field or behaviour is accepted the way the vendored
  manual documents it. See `docs/operations/borderconnect-live-validation.md`
  for the runbook that flips these flags on.
- **Supported** means there is no additional gate beyond BorderConnect being
  configured for the organization — it still needs a live round trip before
  a real pilot carrier should rely on it (see the production runbook's
  "Deployment gates").
