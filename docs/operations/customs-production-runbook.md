# Customs production runbook

This runbook is the operational gate for the controlled BorderConnect pilot.
The named owner is the role on duty, not an individual: **Operations On-call**
owns initial response, **Customs Integration Owner** owns provider escalation,
and **Platform Owner** owns database, Redis, worker, and telemetry failures.

## Deployment gates

Before the first customer filing:

- Rotate any BorderConnect credential ever referenced outside the secret
  manager. Store only `BORDERCONNECT_API_URL_SUFFIX`, `BORDERCONNECT_API_KEY`,
  and `BORDERCONNECT_TEST_COMPANY_KEY` values in the approved private
  environment.
- Configure `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, and the Sentry source-map
  variables. Configure an OTLP metric endpoint with
  `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Set `READINESS_SECRET` (a random string) and give it to internal monitoring
  only. Confirm `/api/health` returns process liveness and `/api/ready`
  returns 200 with only `{ ok: true }` when called with no credential, and
  the full readiness body when called with `Authorization: Bearer
  $READINESS_SECRET`. Readiness fails closed on Postgres, configured Redis,
  missing production variables, jobs overdue by two minutes, expired leases,
  a live BorderConnect drain older than three minutes, or missing provider
  activity while submissions are waiting.
- Configure and deliberately test every Sentry rule below. Record the issue
  link, delivery timestamp, recipient, and acknowledgement in the pilot log.
- Run the ACE and ACI smoke commands against the approved service-provider
  test account. `autoSend` is false by default and cannot be overridden. Keep
  the generated `artifacts/borderconnect-smoke/` evidence outside Git.
- Complete one real ACE and one real ACI original-filing round trip through
  Corridor, including provider acknowledgement, government response, inbox
  persistence, tenant routing, duplicate handling, and application timeline.
- Exercise ACE amend/cancel, rejection, and unroutable-message cases.

See `docs/operations/borderconnect-live-validation.md` for the full
step-by-step procedure behind the two items above, including the empty-trip
and multi-trailer runs that gate `BORDERCONNECT_EMPTY_TRIP_ENABLED` and
`BORDERCONNECT_MULTI_TRAILER_ENABLED`, and the evidence-recording templates
under `docs/operations/evidence/`.

Pilot commands:

```bash
pnpm --filter @corridor/integrations smoke:borderconnect -- --regime=ACE
pnpm --filter @corridor/integrations smoke:borderconnect -- --regime=ACI
```

Only use `--drain-shared-queue` during an isolated window with the production
drain stopped and no carrier filing. The receive endpoint is pop-on-read.

## Health and metrics

`/api/health` is liveness only. `/api/ready` requires no credential and
returns only `{ ok: true|false }` to that shallow caller — internal
monitoring presents `Authorization: Bearer $READINESS_SECRET` to get the
full body, which is still limited to booleans, counts, ages, status labels,
and missing variable names — never values, payloads, account identifiers, or
connection errors. It does not call BorderConnect.

The OTLP exporter emits these low-cardinality instruments:

| Metric                                                   | Meaning                                            |
| -------------------------------------------------------- | -------------------------------------------------- |
| `corridor.customs.outbound.duration`                     | Provider request latency by provider and operation |
| `corridor.customs.outbound.failures`                     | Failed outbound requests                           |
| `corridor.customs.inbox.received/stored/processed`       | Inbox flow counts                                  |
| `corridor.customs.inbox.duplicates/unroutable/failures`  | Deduplication, routing, and processing failures    |
| `corridor.jobs.queue.depth` / `corridor.jobs.oldest.age` | Backlog size and oldest job age                    |
| `corridor.customs.ack.duration`                          | Submission acknowledgement latency                 |
| `corridor.ai.extraction.duration/failures`               | Extraction performance and terminal failures       |
| `corridor.ai.failures`                                   | Model, embedding, and copilot failures             |
| `corridor.watchdog.issues`                               | Grouped watchdog condition counts                  |

Metric attributes never include organization, movement, shipment, document,
person, or provider routing identifiers.

## Content Security Policy rollout

Every response carries a per-request nonce-based CSP (`apps/web/src/proxy.ts`,
`apps/web/src/lib/csp.ts`), shipped as `Content-Security-Policy-Report-Only`
by default so nothing breaks silently. `script-src` is `'self'
'nonce-<random>' 'strict-dynamic'`; `style-src` keeps `'unsafe-inline'`
because nonces do not cover React's inline `style={{}}` attribute, only
`<style>` tags. Run report-only for one full pilot week, review delivered
CSP reports (via `CSP_REPORT_URI`, when configured) or the browser console
across a full pilot walkthrough, then set `CSP_ENFORCE=true` to switch the
header to the enforced `Content-Security-Policy` name. `apps/web/src/proxy.test.ts`
and `apps/web/src/lib/csp.test.ts` cover the header logic; there is no
automated substitute for a live console check across login, dashboard, the
movement wizard, copilot, and documents before flipping the flag in
production.

## Sentry alert rules

Create one issue alert per table row in the production Sentry project. Filter
on `component:customs-watchdog` and the exact `condition` tag. Notify the
Operations On-call channel immediately for critical conditions and within five
minutes for error conditions. Use the stable fingerprint to group recurring
one-minute observations into one issue.

| Condition tag                      | Severity                          | Owner                     | Investigation query / first check                                                                                                                                | Retry policy                                                                                                                                                      | Escalation                                                                          |
| ---------------------------------- | --------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `stale_submission`                 | Critical                          | Customs Integration Owner | Count `customs_submissions` in `sent`/`acknowledged` with `updated_at < now() - interval '5 minutes'`; inspect the tenant-scoped submission timeline in Corridor | Do not re-file blindly. Confirm whether the provider imported the original correlation first; retry only a documented idempotent action                           | Page Operations immediately; provider case after 10 minutes                         |
| `drain_job_unhealthy`              | Critical                          | Platform Owner            | Check latest `customs.borderconnect_drain` rows, lease expiry, and `/api/ready`                                                                                  | Let the queue lease/backoff retry once; run the cron route once with the cron credential only after the prior lease is expired                                    | Page Platform immediately; Customs owner if receive is still stale after recovery   |
| `inbox_processing_unhealthy`       | Error                             | Platform Owner            | Count unprocessed `customs_inbox` rows and group `processing_error` prefixes; never paste `payload` into chat or Sentry                                          | Fix the deterministic cause and allow the next drain; poison rows stop after the existing fifth attempt                                                           | Page Platform after 10 minutes or immediately if backlog grows                      |
| `tenant_routing_unhealthy`         | Critical                          | Customs Integration Owner | Group `processing_error` into unknown/ambiguous; compare routing in the tenant-scoped UI and redacted smoke fingerprints                                         | Never guess a tenant and never edit payload routing. Correct approved organization mapping, call `integrations.inbox.reprocess` for the row, then rerun the drain | Page Operations immediately; provider escalation for missing/incorrect routing keys |
| `provider_failure_elevated`        | Critical at ≥50%, Error otherwise | Customs Integration Owner | Compare 15-minute outbound request/failure counts and provider status; inspect redacted Sentry exceptions                                                        | Retry only retryable 429/5xx failures with the existing bounded job backoff; no automatic retry for authentication/data errors                                    | Page at critical; provider case after two bounded retries                           |
| `acknowledgement_latency_elevated` | Error                             | Customs Integration Owner | Review p95 `corridor.customs.ack.duration`, latest successful provider activity, and submission states                                                           | Do not duplicate a filing while its acknowledgement is unknown; reconcile by correlation/routing key first                                                        | Escalate after 10 minutes or sooner when filings approach crossing time             |

The database queries above return counts first. Inspect row-level records only
inside the authorized tenant UI or an audited production console.

Test all rule paths after configuring their actions:

```bash
SENTRY_ENVIRONMENT=production \
pnpm --filter @corridor/borderconnect-listener test:watchdog-alerts -- --confirm
```

The command emits six redacted `[TEST]` issues with `alert_test:true`; it does
not alter customs or customer data. Delete or resolve those test issues after
recording delivery evidence.

## WebSocket test window

HTTP polling remains the pilot receive transport. The WebSocket listener may
run only in an announced isolated test window with the HTTP drain stopped and
no customer filing. Stop the listener before re-enabling the drain. Until the
provider confirms whether socket delivery competes with the shared HTTP queue,
never deploy both as live consumers.

Live receive requires a persistent 0700 encrypted spool volume configured by
`BORDERCONNECT_SPOOL_DIR` and `BORDERCONNECT_SPOOL_KEY`. A persistence failure
stops polling and leaves the batch on disk for replay after recovery.

## Feature truth and GA gates

See `docs/operations/supported-filing-matrix.md` for the full scenario-by-
scenario table (generated from `filing-matrix.test.ts`, the executable
source of truth). Summary:

- Keep `BORDERCONNECT_ACI_AMEND_ENABLED=false` until a written provider
  sequence and a successful CBSA amendment round trip are attached to the
  release record.
- Keep `BORDERCONNECT_MULTI_TRAILER_ENABLED=false` until a live BorderConnect
  round trip with more than one trailer attached validates the `loadedOn`
  field (0051). A single trailer or bobtail movement is unaffected — the
  capability only gates a manifest with two or more trailers hitched.
- Keep `BORDERCONNECT_EMPTY_TRIP_ENABLED=false` until a live BorderConnect
  round trip with a declared-empty trip ("Empty Trailer" / "Empty Trip") is
  validated — neither the ACE nor ACI manual documents an explicit empty
  indicator field, so this is the one filing shape whose wire behaviour is
  entirely unverified live.
- QP In-Bond is tracking-only. Special filings that the capability/preflight
  matrix blocks remain unavailable.
- Tariff and border-wait values remain synthetic experimental data and never
  contribute to compliance or inspection risk.
- AI extraction remains human-reviewed and unavailable to the pilot until the
  50-document private-corpus gate passes. GA requires 250 documents and the
  documented accuracy thresholds.
- The mobile app remains beta until the physical iPhone/Android matrix passes.

Live provider round trips, external alert delivery, document-corpus results,
and physical-device results are evidence gates; automated tests in this
repository do not substitute for them.
