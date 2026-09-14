# Security policy

## Supported versions

Nothing has been tagged or released yet. `main` is the only supported branch; fixes land there.

## Reporting a vulnerability

**Do not open a public issue.** Email the address published at `<deployment
URL>/.well-known/security.txt` and on the `/legal/security` (Vulnerability Disclosure Policy)
page — both are generated from the `NEXT_PUBLIC_SECURITY_EMAIL` deployment variable
(`apps/web/src/lib/legal.ts`), so there is one real address, not a placeholder frozen in this
file. Include:

- a description of the vulnerability,
- steps to reproduce,
- the impact you believe it has,
- a suggested fix, if you have one.

We aim to acknowledge within 48 hours and to give a remediation timeline within 5 business days.

`docs/security-review.md` is the standing security review: what has been verified, how to re-run
each check, and the open findings with their severity. Read it before reporting — a known,
documented finding is listed there.

## Security architecture

Everything below is a claim you can check against the file it names, or a query you can re-run.
`docs/security-review.md` carries the evidence.

### Multi-tenancy: RLS is the tenant boundary

- Every tenant table carries `organization_id uuid references organizations(id)` and has
  `enable row level security`.
- Policies go through `has_permission(org_id, 'permission.key')` or `is_org_member(org_id)`.
- The API reads and writes tenant data inside `ctx.rls(...)`, a transaction that runs as
  `authenticated` with the caller's JWT claims (`packages/db/src/rls.ts`). `withServiceRole()` is
  the only bypass; its call sites are enumerated in the review (§8) and each filters
  `organization_id` itself.
- Cross-tenant isolation is covered by integration tests
  (`packages/db/src/*.integration.test.ts`).

### Authentication and sessions

- Supabase Auth: email/password, plus SAML SSO on the Enterprise plan.
- Session cookies are `httpOnly`, `sameSite: "lax"`, and `secure` when
  `NODE_ENV === "production"` (`apps/web/src/lib/supabase/server.ts`). The `NODE_ENV` dependency
  is finding F3 in the review.
- The API and the Expo app authenticate with `Authorization: Bearer <access token>`; the same
  session resolution, permissions and RLS apply.
- Realtime uses a short-lived access token from `/api/realtime/token`; no refresh token is
  exposed to the browser.

### Authorization

- Permission keys live in `packages/domain/src/permission.ts`.
- System roles (Owner, Dispatch, Compliance, Read-only, Driver Portal) are seeded per
  organization; organization admins can define custom roles, and may only grant permissions they
  themselves hold.
- Permission checks are middleware on the tRPC procedure, not something a service is trusted to
  remember: `permissionProcedure(...)` for a standard-tier procedure, `aiProcedure(...)` for one
  that invokes a model (permission first, then the tighter `ai` rate limit).
- SECURITY DEFINER functions that are callable by `authenticated` re-check the caller themselves;
  §9b of the review is the table of every one of them.

### Secrets

| Secret                                              | Storage                                                                      | Reachable by                                                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase service-role key                           | deployment env                                                               | server only — workers and webhooks (review §8)                                                                                                                                                                                     |
| AI Gateway / OpenAI keys                            | deployment env                                                               | server only, via the `@corridor/ai` resolver                                                                                                                                                                                       |
| Stripe secret + webhook secret                      | deployment env                                                               | server only (`@corridor/integrations`)                                                                                                                                                                                             |
| Upstash Redis REST URL + token                      | deployment env                                                               | server only                                                                                                                                                                                                                        |
| Integration credentials (customs, …)                | **Supabase Vault**                                                           | `read_integration_secret` is `service_role` only; writes go through `store_integration_secret`, gated on `integrations.manage`                                                                                                     |
| Supabase Auth webhook secret                        | deployment env                                                               | the webhook handler only                                                                                                                                                                                                           |
| Resend / Twilio / Expo push credentials             | deployment env                                                               | server only (`@corridor/integrations`); unset = logged mock send                                                                                                                                                                   |
| Customs gateway base URL + API key + webhook secret | deployment env (fallback) or **Supabase Vault** (per-org)                    | server only (`@corridor/integrations`); unset = fixture replay, no live transmit                                                                                                                                                   |
| BorderConnect API URL suffix + API key              | deployment env (account-wide, one Service Provider account for every tenant) | server only (`@corridor/integrations`, `apps/borderconnect-listener`); unset = fixture replay. `BORDERCONNECT_TEST_COMPANY_KEY` is read only by `packages/integrations/scripts/borderconnect-smoke.ts`, never by application code. |

Never committed: `.gitignore` ignores `.env` and `.env.*`, with `!.env.example` as the single
tracked exception — and that file holds names, never values.

### AI safety

- One resolver (`packages/ai/src/client.ts`): Gateway → OpenAI → mock. Call sites never construct
  a provider.
- No auto-commit. Extraction output is validated against the `extractedDocument` schema and
  applied only by a human reviewer; rate-confirmation data is display-only and never creates
  cargo lines.
- Mock mode is complete: the whole test suite passes with no AI key set.
- The embedding model must be 1536-dimensional (the pgvector column width); `createEmbedder`
  throws otherwise.

### Rate limiting

- Upstash Redis sliding window, with an in-memory fallback for local development.
- Two tiers: `standard` for org-scoped procedures, `ai` for the ones that invoke a model.
- Per-plan limits (requests/minute), from `packages/api/src/infra/ratelimit.ts`:

  | Plan         | standard | ai  |
  | ------------ | -------- | --- |
  | trial        | 60       | 5   |
  | starter      | 120      | 20  |
  | professional | 300      | 60  |
  | enterprise   | 600      | 120 |

- The key is `${tier}:${orgId}`, so one tenant cannot spend another's budget.
- The limiter falls back to the per-instance in-memory sliding window if Redis is unreachable,
  rather than failing open — a degraded cache lowers the ceiling to per-instance accuracy instead
  of removing it (finding F2, resolved; see `docs/security-review.md`).

### Webhooks

| Webhook         | Verification                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe          | `stripe.webhooks.constructEvent` with `STRIPE_WEBHOOK_SECRET`                                                                                 |
| Supabase Auth   | Standard Webhooks HMAC-SHA256 with `SUPABASE_AUTH_WEBHOOK_SECRET`                                                                             |
| Customs gateway | HMAC-SHA256 over the raw body, hex in `X-Corridor-Signature`, with `CUSTOMS_GATEWAY_WEBHOOK_SECRET`. Unset = every delivery refused with 401. |

BorderConnect has no inbound webhook to verify: it never pushes to Corridor. `customs.
borderconnect_drain` (`/api/jobs/borderconnect-drain`, cron once daily — the Vercel Hobby
plan rejects cron expressions that run more than once a day) and the standalone
`apps/borderconnect-listener` WebSocket process both pull from BorderConnect's own shared inbox
using the account's `Api-Key`, so there is nothing for an attacker to forge a signature against —
see review §8 for how each writes to `customs_inbox` under `withServiceRole`.

Cron routes (`/api/jobs/process`, `/api/jobs/expiry-scan`, `/api/jobs/notices-sync`,
`/api/jobs/borderconnect-drain`, `/api/jobs/customs-watchdog`) fail closed through
`cronAuthFailure()`: an unset `CRON_SECRET` is a 503, a wrong one a 401 compared with
`timingSafeEqual`.

`GET /api/ready` shares the same `bearerSecretFailure()` helper (`readinessAuthFailure()`,
checked against `READINESS_SECRET`): with no bearer, or the wrong one, it returns only
`{ ok: true|false }`; the full body — queue depth, provider-activity age, missing production
variable names — is returned only with the correct bearer. See finding F7.

### Audit logging

- Mutations write to `audit_log` through `writeAudit()`
  (`packages/api/src/services/audit.ts`), which calls the membership-checked `log_audit()`
  definer — `authenticated` has no direct INSERT on the table.
- Every mutation in the router is _classified_: it is either in `AUDITED_MUTATIONS` or, with a
  written reason, in `AUDIT_EXEMPT_MUTATIONS`. `packages/api/src/audit-coverage.test.ts` fails the
  build on a mutation that is in neither, and on a listed name that no longer exists.
- Columns: `organization_id`, `actor_id`, `action`, `entity_type`, `entity_id`, `before`, `after`,
  `created_at`.

### Data protection

- PII (email, display name) lives in `user_profiles` under RLS.
- No card data touches Corridor: Stripe hosted checkout and the customer portal only.
- Uploaded documents live in Supabase Storage; upload URLs are signed with the **caller's**
  session, so Storage RLS applies to the upload itself.
- Transmitted customs manifests **are** retained, in `integration_events.request`/`response`,
  because the transmission record is the compliance artefact. They are tenant-scoped and readable
  only with `integrations.manage` or `movement.read`.
- Sentry events pass through `@corridor/observability`'s fail-closed scrubber:
  request bodies/headers, customs and document payloads, credentials, company
  keys, identity fields, and frame variables are removed before export.

### Response headers

`apps/web/next.config.ts` sets `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` denying camera,
microphone and geolocation, `Strict-Transport-Security` (`max-age=63072000; includeSubDomains`)
and `X-DNS-Prefetch-Control: off`.

Every response also carries a per-request nonce-based Content Security Policy
(`apps/web/src/proxy.ts`, `apps/web/src/lib/csp.ts`): `script-src 'self' 'nonce-<random>'
'strict-dynamic'`, shipped as `Content-Security-Policy-Report-Only` until `CSP_ENFORCE=true`
switches it to the enforced header name. `style-src` keeps `'unsafe-inline'` because CSP nonces
do not cover React's inline `style={{}}` attribute, only `<style>` tags. See finding F8 and
`docs/operations/customs-production-runbook.md`'s "Content Security Policy rollout" section for
the enforcement plan.

## Secure development practices

### Checks before a change lands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration                       # RLS isolation, requires local Supabase
pnpm db:lint                                # supabase db lint, fails on warnings
pnpm --filter @corridor/db verify:mirror    # Drizzle schema vs. the live database
```

`pnpm db:lint` is what catches a SECURITY DEFINER function with no `SET search_path`, and a
table with RLS disabled. It does **not** reason about policy predicates — that is what the
cross-tenant integration tests and review are for.

### Dependencies

- `pnpm-lock.yaml` is committed; updates are reviewed by hand.
- `onlyBuiltDependencies` in `pnpm-workspace.yaml` limits which packages may run install scripts.
- `.github/workflows/security.yml` runs `dependency-review-action` on every pull request
  (fails on a high-severity advisory), a weekly `pnpm audit --prod --audit-level high`, and a
  Gitleaks secret scan on every push and PR. `.github/dependabot.yml` opens weekly update PRs for
  both npm and GitHub Actions dependencies (finding F6, resolved). CI itself is not dispatched
  from this environment (billing) — verify locally with the commands below until it is re-enabled.

### If something happens

1. Contain — rotate the affected keys, disable the endpoint.
2. Assess — what was reachable, for whom, for how long.
3. Remediate — patch, deploy, verify with a test that would have caught it.
4. Notify — affected customers, and regulators where required.
5. Write it up, and add the finding to `docs/security-review.md`.

## Checklist for contributors

- [ ] No secret in code, log line or comment
- [ ] RLS enabled and policies written for any new table
- [ ] Cross-tenant integration test for any new table
- [ ] New mutation classified in `AUDITED_MUTATIONS` or `AUDIT_EXEMPT_MUTATIONS`
- [ ] A SECURITY DEFINER function callable by `authenticated` re-checks the caller
- [ ] Webhook signature verified for any new webhook
- [ ] Vault used for any new integration credential
- [ ] The feature still works with the external service's env var unset (mock mode)
- [ ] `pnpm db:lint` and `pnpm test:integration` pass
