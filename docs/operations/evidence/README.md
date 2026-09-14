# Evidence records

This directory holds the human-written record that a pilot-readiness gate
actually ran, against real inputs, with a real result — not the automated
test output itself. Three gates use it:

| Gate | Template | What it proves |
| --- | --- | --- |
| BorderConnect live validation | `TEMPLATE-borderconnect-live.md` | A real ACE/ACI round trip through Corridor, not a fixture replay |
| AI extraction accuracy | `TEMPLATE-extraction-gate.md` | The private-corpus pilot/GA accuracy gate passed |
| Mobile physical-device QA | `TEMPLATE-mobile-device-qa.md` | Every scenario in `docs/operations/mobile-device-qa.md` passed on real hardware |

## Rules for every record

- **Copy the template, don't edit it in place.** Name the copy
  `<gate>-<yyyy-mm-dd>.md` (e.g. `borderconnect-live-2026-10-03.md`) and fill
  in every field; a blank field means the check was not actually done.
- **Aggregate facts only.** Counts, statuses, dates, hashes, who verified it —
  never a document's content, a customs payload, a driver's PII, or a raw
  provider credential. If a template field would require one of those,
  something upstream is wrong; fix that instead of filling the field in.
- **Link to the automated output, don't paste it.** A CI run URL, an
  artifact name, an `artifacts/borderconnect-smoke/` file path — the record
  is evidence that the run happened and what it showed, not a copy of the
  run itself.
- **One record per attempt, including failures.** A failed gate attempt is
  still worth recording — it is what "before" looked like when the gate
  later passes.

These records are not automated tests; nothing in this repository enforces
that one exists before the corresponding `BORDERCONNECT_*_ENABLED` flag or
release decision changes. That enforcement is a human process, described in
each gate's own runbook.
