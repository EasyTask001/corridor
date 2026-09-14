# Mobile physical-device QA

The shipped app remains labelled **Beta** until every row below passes on one
supported physical iPhone and one supported physical Android handset. Record
the app build, OS/device, tester, timestamp, network setup, result, and evidence
link. Emulator and unit results do not satisfy this gate.

| Scenario                                             | iPhone  | Android | Expected result                                                                |
| ---------------------------------------------------- | ------- | ------- | ------------------------------------------------------------------------------ |
| Sign in and restore session after cold launch        | Not run | Not run | Session restores from SecureStore without exposing another user's outbox       |
| Expired session during an API action                 | Not run | Not run | User returns to sign-in; no mutation is reported as completed                  |
| Poor LTE while loading assigned movements            | Not run | Not run | Loading/error state is clear and retry succeeds without duplicate effects      |
| Connection loss during an idempotent queued mutation | Not run | Not run | Offline state and pending count appear; replay occurs once after reconnection  |
| Kill/relaunch with an offline outbox                 | Not run | Not run | The same user's queue survives and replays; a different user cannot inherit it |
| Foreground/background during a request               | Not run | Not run | UI recovers without a stuck spinner or duplicate action                        |
| Camera permission denied                             | Not run | Not run | Actionable permission message; app remains usable                              |
| Photo-library permission denied                      | Not run | Not run | Actionable permission message; app remains usable                              |
| Large photo upload over poor LTE                     | Not run | Not run | Failure is truthful and retryable; no false “uploaded” state                   |
| Connection loss during signed upload                 | Not run | Not run | Incomplete upload is not finalized or shown as complete                        |
| Signature capture and PNG upload                     | Not run | Not run | Signature preview, MIME, upload, and movement document are correct             |
| Push permission denied                               | Not run | Not run | App works without push and does not loop permission prompts                    |
| Push delivery in foreground/background/terminated    | Not run | Not run | One notification opens the correct assigned movement                           |
| Sign out with pending work                           | Not run | Not run | User sees the documented behavior; queue is not replayed under another account |

The repeatable golden path is `apps/mobile/.maestro/smoke.yaml`:

```bash
pnpm --filter @corridor/mobile test:e2e
```

It covers sign-in, assigned-load navigation, document upload, proof-of-delivery
signature upload, and sign-out. Its header is intentionally truthful about its
current execution status; update the matrix and remove that warning only after
recording real-device runs.

**First run note:** `apps/mobile/.maestro/smoke.yaml`'s own header says it was
written without device access and nothing in it has been run — expect to fix
element selectors and timing on the first real device pass, then delete that
warning from the file once it goes green.

## Running the pilot gate

`.github/workflows/release-gates.yml`'s `mobile` job downloads a signed
evidence file from `CORRIDOR_MOBILE_QA_EVIDENCE_URL` (bearer
`CORRIDOR_MOBILE_QA_EVIDENCE_TOKEN`) and runs
`apps/mobile/scripts/verify-device-qa.mjs` against it. That script requires
this exact shape:

```json
{
  "recordedAt": "2026-10-01T00:00:00Z",
  "commit": "<git sha the runs were performed against>",
  "maestro": { "status": "passed" },
  "cases": [
    { "scenario": "Sign in and restore session after cold launch", "device": "iPhone", "status": "passed" },
    { "scenario": "Sign in and restore session after cold launch", "device": "Android", "status": "passed" }
  ]
}
```

- `cases` needs at least `REQUIRED_DEVICE_QA_CASES` (28 — the 14 rows above ×
  iPhone + Android) entries, every one `status: "passed"`.
- `maestro.status` must be `"passed"`.
- `recordedAt` and `commit` are required so a stale evidence file cannot be
  replayed against a newer release without someone noticing the mismatch.

Host the file wherever `CORRIDOR_MOBILE_QA_EVIDENCE_URL` can reach it with the
bearer token — this repository never stores it, since it is proof a specific
human ran specific tests on specific hardware, not something to regenerate.

## On failure

`verify-device-qa.mjs` throws on the first problem it finds: too few cases, a
case not marked `passed`, a missing/failed Maestro run, or missing
`recordedAt`/`commit`. Fix the underlying scenario on the physical device, not
the evidence file — a JSON edit to make the gate pass without a fresh run
defeats the point of a physical-device gate entirely.
