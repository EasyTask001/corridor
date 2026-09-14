# AI extraction accuracy gate — [pilot|GA]

Copy this file to `extraction-<gate>-<yyyy-mm-dd>.md`, delete this line, and
fill in every field. See `docs/operations/document-extraction-evaluation.md`
for the procedure this records.

## Summary

- **Date:**
- **Gate:** pilot (50 documents, 95% critical / 90% overall) or GA (250
  documents, same thresholds)
- **Corpus source:** (where the sanitized private corpus came from — never
  the documents themselves)
- **Verified by:**
- **Outcome:** pass / fail

## Aggregate results

Copied from the report's summary section only:

| Metric | Value |
| --- | --- |
| Document count | |
| Overall accuracy | |
| Critical-field accuracy | |
| Documents below threshold | |

## Per-field accuracy (aggregate percentages only)

| Field | Accuracy | Notes |
| --- | --- | --- |
| | | |

## Evidence

- **Workflow run:** link to the `release-gates.yml` run
- **Report artifact:** artifact name (`extraction-pilot-report` /
  `extraction-ga-report`) — download and delete locally after this record is
  written; never commit it

## Follow-up (if failed)

- [ ] Fields identified as systematically weak, and whether the fix is
      prompt, schema, or corpus-quality
- [ ] Re-run scheduled for:
