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
