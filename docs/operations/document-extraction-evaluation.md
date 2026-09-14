# Document extraction release evaluation

Tracked fixtures under `packages/ai/src/eval/fixtures` are synthetic regression
examples only. They are not pilot or GA evidence. Raw customer documents must
never be committed; keep the sanitized corpus in approved private storage and
materialize it outside the repository (or under the ignored
`private-eval-corpus/` path for a short-lived local run).

Each source file needs a sibling `<name>.expected.json`. Supported source
formats are text, PDF, PNG, and JPEG. Expected JSON contains only the fields
that should be scored. The report contains aggregate counts and accuracy—not
document contents, expected values, or customer identifiers.

Pilot gate:

```bash
CORRIDOR_EVAL_GATE=pilot \
CORRIDOR_EVAL_CORPUS_DIR=/path/to/private/sanitized-corpus \
CORRIDOR_EVAL_EXTRACTOR=model \
CORRIDOR_EVAL_REPORT_PATH=/path/to/private/pilot-report.json \
pnpm --filter @corridor/ai eval
```

GA uses `CORRIDOR_EVAL_GATE=ga`. The executable gates are:

| Gate  | Minimum documents | Critical-field accuracy | Overall accuracy |
| ----- | ----------------: | ----------------------: | ---------------: |
| Pilot |                50 |                     95% |              90% |
| GA    |               250 |                     95% |              90% |

Reports include per-document-type and normalized per-field accuracy, plus a
separate critical-field rollup. Critical fields cover identity/control fields,
parties, commodity description, HS code, pieces/quantity, weight, value,
origin, and the operational fields on rate confirmations. Human apply/review
remains mandatory even after the gates pass.

## Running the pilot gate

The command above runs locally against a corpus on disk. For the actual
pilot-readiness record, dispatch `.github/workflows/release-gates.yml`
instead — it downloads the protected sanitized corpus itself, so the
documents never sit in a local checkout longer than the job needs them:

1. `gh workflow run release-gates.yml -f extraction_gate=pilot` (needs
   `CORRIDOR_EVAL_CORPUS_URL`/`CORRIDOR_EVAL_CORPUS_TOKEN` and an AI provider
   key configured as repository secrets in the `production-gates`
   environment — see the workflow file for the exact names).
2. Once it finishes, download the `extraction-pilot-report` artifact
   (`gh run download <run-id> -n extraction-pilot-report`).
3. Copy only the aggregate numbers — document count, critical-field accuracy,
   overall accuracy, per-field breakdown — into
   `docs/operations/evidence/extraction-pilot-<date>.md` (start from
   `docs/operations/evidence/TEMPLATE-extraction-gate.md`). Never commit the
   report JSON itself or any document content.
4. Delete the local copy of the downloaded artifact once the evidence record
   is written.

## What to do on failure

The report's per-field accuracy table says which fields are dragging the
average down. A field failing systematically across many documents is a
prompt or schema problem — look at the extraction prompt in
`packages/ai/src/document-intelligence/model-extractor.ts` and the field's
Zod schema in `packages/domain/src/document.ts` before touching individual
fixtures. A
handful of unrelated one-off misses across different fields is more likely a
corpus quality issue (a scan too poor to read, a form Corridor doesn't
support yet) — note those in the evidence record rather than chasing the
average down to zero; the gate is a threshold, not a promise of perfection.
Re-run the gate after any prompt or schema change before re-recording
evidence — a stale report against changed code is worse than no report.
