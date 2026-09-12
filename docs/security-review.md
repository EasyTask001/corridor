# Security review

Reviewed at `117531d` (gap-closure Tasks 1–8 landed), against the §10 checklist
in the build plan; §9b and finding C1 were added by the whole-branch review that
followed Task 11 and fixed in `eb72589`. Refreshed 2026-09-11 after the
`docs/AUDIT-2026-09-11.md` remediation branch merged (migrations through
`0045`) and issues #3–#5 closed the gaps it found in this doc's own claims
(§6, §8, §9, F4 below) — those sections and finding were re-verified directly
against `pg_proc`/`has_function_privilege` rather than carried forward. Every
claim below is a file reference or a query you can re-run; nothing here is
asserted from memory.

Scope: the Next.js app (`apps/web`), the tRPC API (`packages/api`), the database
and its policies (`supabase/migrations/0001`–`0045`). Out of scope: the Expo app
(`apps/mobile`), and the mock customs gateways, which never see a real
credential.

## How to re-run the checks

```sh
pnpm db:lint                                       # plpgsql/schema lint, fails on warnings
pnpm db:advisors                                   # size/index/cache stats for the local DB
pnpm --filter @corridor/db test:integration        # RLS cross-tenant tests
pnpm --filter @corridor/api test                   # includes audit-coverage.test.ts
```

`docker exec supabase_db_Corridor psql -U postgres -d postgres` reproduces the
RLS and `search_path` tables below.

---

## 1. No JWTs or passwords reach the client

| Check                                        | Status | Evidence                                                                                                                                                                            |
| -------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session tokens are never rendered into HTML  | PASS   | `grep -rn 'type="hidden"' apps/web/src` returns eight inputs, all of them `regime` / `status` / `next` / invite `token` filters. No JWT, no password, no user id.                   |
| No token in browser storage                  | PASS   | `grep -rn "localStorage\|sessionStorage" apps packages` — zero hits. The browser Supabase client is created with **no session of its own** (`apps/web/src/lib/supabase/client.ts`). |
| No `dangerouslySetInnerHTML`                 | PASS   | Zero hits across `apps` and `packages`.                                                                                                                                             |
| Only three `NEXT_PUBLIC_*` variables exist   | PASS   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL`. The anon key is public by design; it is RLS-bounded.                                            |
| The one deliberate token hand-off is bounded | PASS   | See below.                                                                                                                                                                          |

**The realtime token route** (`apps/web/src/app/api/realtime/token/route.ts`) is
the single place a JWT is handed to the page, and it is deliberate. Its own
header states the four properties that make it safe, all of which hold in the
code: only the **access token** leaves the server (the refresh token stays in the
httpOnly cookie, so a stolen token dies with the 1 h `jwt_expiry` and cannot be
traded for a session); it mints nothing, returning the caller's own session
gated on `getUser()`; it rejects cross-origin callers explicitly and sets no CORS
headers; and it answers `no-store`.

Verified live: with the session cookie it returns a token, without it a `401`.

The reason it exists is `apps/web/src/lib/supabase/client.ts` — because the auth
cookies are httpOnly, the browser client cannot read a session, and a Realtime
socket left as `anon` is silently dropped by every `to authenticated` policy.

## 2. Cookies are httpOnly + secure + sameSite

Both writers set all three flags explicitly, overriding whatever `@supabase/ssr`
proposes:

- `apps/web/src/lib/supabase/server.ts` — Server Components, Route Handlers,
  Server Actions, tRPC context.
- `apps/web/src/proxy.ts` — the session refresh on every request.

Both use `httpOnly: true`, `secure: process.env.NODE_ENV === "production"`,
`sameSite: "lax"`. `secure` is conditional so local HTTP development works; in
production it is on.

`proxy.ts` also uses `getUser()` rather than `getSession()`, so the JWT is
validated against Supabase Auth instead of trusted from the cookie.

## 3. No card data touches Corridor

`apps/web/src/app/api/webhooks/stripe/route.ts` mirrors subscription state only;
card entry happens in Stripe Checkout and the Stripe Portal. The columns
Corridor stores are `stripe_customer_id` / `stripe_subscription_id` / plan /
period (`supabase/migrations/0004_integrations.sql`,
`0013_usage_billing.sql`) — identifiers, never a PAN, and the repo contains no
card field anywhere.

## 4. RLS is enabled on every table

All 49 tables in `public` have `relrowsecurity = true`. Each is listed with the
migration that creates it and its policy set:

| Table                                     | Migration | Policies                                  |
| ----------------------------------------- | --------- | ----------------------------------------- |
| `audit_log`                               | 0001      | select                                    |
| `organizations`                           | 0001      | select, update                            |
| `organization_members`                    | 0001      | select, insert, update, delete            |
| `permissions`                             | 0001      | select                                    |
| `role_permissions`                        | 0001      | select, modify (ALL)                      |
| `roles`                                   | 0001      | select, insert, update, delete            |
| `user_profiles`                           | 0001      | select, update                            |
| `compliance_alerts`                       | 0002      | select, insert, update, delete            |
| `drivers`                                 | 0002      | select, insert, update, delete            |
| `partners`                                | 0002      | select, insert, update, delete            |
| `trailers`                                | 0002      | select, insert, update, delete            |
| `trucks`                                  | 0002      | select, insert, update, delete            |
| `commodities` (was `cargo`, renamed 0019) | 0003      | select, modify (ALL)                      |
| `movement_amendments`                     | 0003      | select, insert, update, delete            |
| `movement_events`                         | 0003      | select, insert                            |
| `movements`                               | 0003      | select, insert, update, delete            |
| `organization_counters`                   | 0003      | **none — deny-all by design** (see below) |
| `seals`                                   | 0003      | select, modify (ALL)                      |
| `background_jobs`                         | 0004      | select, insert                            |
| `integration_configs`                     | 0004      | select, modify (ALL)                      |
| `integration_events`                      | 0004      | select, insert                            |
| `subscriptions`                           | 0004      | select                                    |
| `source_documents`                        | 0005      | select, insert, update, delete            |
| `notification_rules`                      | 0006      | select, insert, update, delete            |
| `notifications`                           | 0006      | select, update                            |
| `organization_knowledge_embeddings`       | 0007      | select, insert, update, delete            |
| `regulation_documents`                    | 0007      | select                                    |
| `regulation_embeddings`                   | 0007      | select                                    |
| `movement_suggestions`                    | 0009      | select, insert, update                    |
| `usage_records`                           | 0013      | select                                    |
| `organization_sso`                        | 0014      | select, insert, update, delete            |
| `user_devices`                            | 0015      | select, insert, update, delete            |
| `ports`                                   | 0018      | select                                    |
| `organization_carrier_codes`              | 0018      | select, insert, update, delete            |
| `commodity_hazmat`                        | 0019      | select, modify (ALL)                      |
| `shipments`                               | 0019      | select, insert, update, delete            |
| `movement_crew`                           | 0020      | select, modify (ALL)                      |
| `driver_documents`                        | 0020      | select, modify (ALL)                      |
| `equipment_types`                         | 0021      | select                                    |
| `equipment_plates`                        | 0021      | select, modify (ALL)                      |
| `movement_trailers`                       | 0021      | select, modify (ALL)                      |
| `customs_submissions`                     | 0023      | select, insert, update                    |
| `carrier_notices`                         | 0023      | select                                    |
| `generated_documents`                     | 0024      | select, insert                            |
| `external_shipments`                      | 0026      | select, modify (ALL)                      |
| `in_bond_records`                         | 0026      | select, modify (ALL)                      |
| `in_bond_events`                          | 0026      | select, insert                            |
| `pars_rns_events`                         | 0027      | select, insert                            |
| `import_batches`                          | 0028      | select, modify (ALL)                      |

`organization_counters` carries RLS with **zero** policies on purpose: RLS with
no policy denies everything, and the table is reachable only through
`next_movement_number()` (SECURITY DEFINER, which re-checks `is_org_member()`
itself) and the service role. `0003_movements.sql:22` says so in a comment.

Tables whose write policies are missing on purpose are the append-only or
system-written ones: `audit_log` (written by `log_audit()` / the service role,
never updatable — that immutability is the point), `movement_events`
(insert-only, with `movement_events_immutable` as a guard trigger),
`permissions` / `regulation_*` (global reference data), `subscriptions` and
`usage_records` (written by Stripe sync and metering under the service role),
`ports` / `equipment_types` (global CBP/CBSA reference data, seeded by a CSV
importer under the service role), `carrier_notices` (written by the customs
gateway inbound webhook / sync job under the service role), `generated_documents`
/ `in_bond_events` / `pars_rns_events` (append-only event/artifact logs — insert
by the caller, no update or delete).

Storage is covered too: `supabase/migrations/0005_documents.sql:85-102` puts
four `storage.objects` policies on the private `documents` bucket, scoped to
`<org_id>/…` prefixes.

**How the app gets an RLS identity:** `packages/db/src/rls.ts` `withRls()` opens a
transaction, sets `request.jwt.claims` plus `set local role authenticated`, and
runs the query as that role. Every tRPC procedure goes through `ctx.rls(...)`.
Cross-tenant leaks are covered by `packages/db/src/rls.integration.test.ts`.

## 5. Vault holds provider credentials

`supabase/migrations/0012_vault_credentials.sql` moved integration secrets into
Supabase Vault, one secret per `(organization, provider)`:

- `store_integration_secret` / `delete_integration_secret` — SECURITY DEFINER,
  re-check `integrations.manage` themselves (the definer runs as `postgres` and
  therefore bypasses RLS), `execute` revoked from `public` and `anon`, granted to
  `authenticated`.
- `read_integration_secret` — `execute` **revoked from `public`, `anon` and
  `authenticated`**, granted only to `service_role`. The plaintext is
  unreachable from a browser session; it is pulled server-side in
  `packages/api/src/services/customs.ts`.

`integration_configs.credentials_ref` holds the vault pointer, not the secret.

## 6. Rate limiting

`packages/api/src/infra/ratelimit.ts`, applied in `packages/api/src/trpc.ts`:

- Two tiers. `standard` is counted **per user within an org**, so one busy
  colleague cannot lock out the tenant; `ai` is counted **per org**, because
  model spend is a shared plan resource.
- Ceilings per plan: `standard` 60/120/300/600 per minute for
  trial/starter/professional/enterprise; `ai` 5/20/60/120.
- The key always carries the tier and the org id (`rateLimitKey()`), so one
  tenant can never be counted against another's window.
- Public, sessionless endpoints pass an explicit key: `GET /api/auth/sso` counts
  by IP (`sso:ip:<ip>`), which is what stops domain enumeration.
- Upstash when configured, an in-process sliding window otherwise; the fallback
  multiplies the ceilings by 10 outside production only (`rateLimitMultiplier()`).
- Falls back to the in-process sliding window on a Redis error, rather than
  failing open (see F2 — resolved).

Covered by `packages/api/src/ratelimit.test.ts`.

## 7. Webhook signatures are verified

| Endpoint                           | Scheme                                                  | Code                                                                                           |
| ---------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /api/webhooks/stripe`        | Stripe `stripe-signature`, verified on the **raw** body | `apps/web/src/app/api/webhooks/stripe/route.ts` → `parseWebhook()` in `@corridor/integrations` |
| `POST /api/webhooks/supabase-auth` | Standard Webhooks HMAC-SHA256 over `id.timestamp.body`  | `apps/web/src/lib/standard-webhook.ts`, wired in `apps/web/src/lib/auth-webhook.ts`            |

Both read `req.text()` and verify the exact bytes that were signed, never a
re-serialised object. The Standard Webhooks implementation uses
`node:crypto.timingSafeEqual`, supports multiple `v1,` signatures for key
rotation, and rejects anything older than a 5-minute replay window
(`WEBHOOK_TOLERANCE_MS`). It is hand-written rather than pulled from npm on the
stated grounds that a dependency that can verify signatures can forge them.

Cron endpoints authenticate with `CRON_SECRET` compared under `timingSafeEqual`
after a length check. Both routes (`apps/web/src/app/api/jobs/expiry-scan/route.ts`,
`apps/web/src/app/api/jobs/process/route.ts`) go through the same
`apps/web/src/lib/cron-auth.ts`, which fails closed in both directions: 503 when
no secret is configured, 401 when it does not match, and no `NODE_ENV` input —
see Finding 1.

## 8. Service-role usage is enumerated and bounded

`SUPABASE_SERVICE_ROLE_KEY` is read in exactly six places, none of them
reachable from a browser bundle:

| Site                                                      | Why                                                                                                                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/app/api/webhooks/supabase-auth/route.ts:97` | Provisioning a profile for a user who has no session yet.                                                                                                            |
| `packages/api/src/services/customs.ts:98`                 | Reading the vault secret (`read_integration_secret` is service-role only).                                                                                           |
| `packages/api/src/services/documents.ts:28`               | Downloading the uploaded object for extraction, in a job with no caller.                                                                                             |
| `packages/api/src/services/pdf.ts:53`                     | Storing a generated PDF/CSV (migration 0024); the object path is scoped to the caller's own organization, gated by the tRPC permission check, not the bucket policy. |
| `packages/integrations/src/sso.ts:52`                     | SAML provider administration via the Auth admin API.                                                                                                                 |
| `packages/db/scripts/seed.ts:21`                          | The seed script — developer tooling, not shipped.                                                                                                                    |

The RLS-bypassing **database** path is `withServiceRole()` (`packages/db/src/rls.ts:56`),
whose contract is that callers must filter by `organization_id` themselves. Its
call sites are the job worker and cron routes (`api/jobs/process`,
`api/jobs/expiry-scan`, `api/jobs/notices-sync`) and `packages/api/src/services/jobs.ts`.
The one service-role claim a signed-in user can trigger, `integrations.jobs.runNow`,
passes `organizationId: ctx.orgId` to `processDueJobs`, which forwards it as
`claim_jobs(…, p_organization_id)` (0041) so only that organization's rows are
claimed, and the procedure returns counts only — never a job's `result` payload.
The remaining call sites are `packages/api/src/services/audit.ts` (audit rows for
actorless events), `packages/api/src/router/billing.ts` (Stripe webhook's
subscription mirror, no session), `packages/api/src/services/usage.ts`
`reportPendingUsage` (queue-wide Stripe usage metering, batched across every
organization by a cron job, not a caller), `packages/api/src/services/notifications.ts`
`notifyUser` (every caller resolves the recipient from an org-scoped row it
already read under RLS before calling in, and must not be inside its own
transaction — see the function's own doc comment), and — since migration
0023 — the customs webhook (`api/webhooks/customs` → `applyInboundCustomsMessage`,
which resolves the gateway's reference number to one organization through
`customs_submissions` before touching anything, and is idempotent per `eventId`).
Each is a place where there is genuinely no caller to derive claims from.
Cross-tenant-leak coverage lives in `packages/db/src/rls.integration.test.ts`.

One caller is the deliberate exception to "filters `organization_id` itself":
`packages/api/src/services/tracking.ts` (public `/track` lookup, migration 0027)
calls `withServiceRole()` to invoke `lookup_shipment_status()`, which matches
across every tenant on carrier code + control number rather than one
organization — there is no session to scope to. The function itself is the
guard: `SECURITY DEFINER`, `search_path` pinned, `EXECUTE` revoked from `anon`
and `authenticated` and granted only to `service_role`, and it returns only
status/port/entry timestamps. The route is additionally IP-rate-limited
(`services/tracking.ts` → `checkPublicRateLimit`) before the lookup runs.

## 9. SECURITY DEFINER functions pin `search_path`

Every application-defined SECURITY DEFINER function in `public` has
`search_path=""` (empty) in `proconfig` — the mutable-search-path escalation is
closed, and every object reference inside them is schema-qualified so an empty
path costs nothing. This tightened from the original `search_path=public` via
migration `0032` (API hardening) and `0039` (lint fixes for the last
stragglers); `packages/db/scripts/lint-migrations.ts` now statically enforces
`set search_path = ''` on every SECURITY DEFINER function in a migration
numbered `0032` or later, so this cannot silently regress (see Finding F4,
resolved). Full list, from `pg_proc`:

`accept_invitation`, `claim_jobs`, `create_organization_with_owner`,
`current_user_permissions`, `delete_integration_secret`, `handle_new_auth_user`,
`has_permission`, `is_assigned_movement`, `is_org_member`, `log_audit`,
`lookup_shipment_status`, `match_org_knowledge`, `match_regulations`,
`movement_suggestions_guard`, `next_movement_number`, `notify_organization`,
`organization_member_role_scope_guard`, `push_tokens_for`,
`read_integration_secret`, `record_usage`, `sso_enforced_for_email`,
`sso_provider_for_email`, `store_integration_secret`, `sync_org_subscription`.

`lookup_shipment_status` (0027) and `push_tokens_for` (0015) are EXECUTE-granted
to `service_role` only, not `authenticated`, so they sit outside the §9b table
below (which covers only functions callable by a signed-in user).

The remaining `public` functions with no `proconfig` are either pgvector/citext
extension functions or SECURITY **INVOKER** trigger guards (`movements_guard`,
`movement_events_immutable`, `set_updated_at`, `reject_modification`, …), which
run with the caller's own privileges and are not an escalation path.

## 9b. Definer functions granted to `authenticated` re-check the caller

Pinning `search_path` (§9) closes escalation _through_ a definer; it says nothing
about who may call one. A SECURITY DEFINER function that is EXECUTE-granted to
`authenticated` and takes an organization id as an argument is, by construction,
a hole in RLS unless it re-derives authorisation itself. Every such function,
and what it checks:

| Function                                            | Reachable by     | Caller check                                                                                                                                                               | ✅  |
| --------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `notify_organization`                               | authenticated    | `is_org_member(p_organization_id)` when `auth.uid()` is set (0017)                                                                                                         | ✅  |
| `record_usage`                                      | authenticated    | `is_org_member(p_org)` when `auth.uid()` is set (0013)                                                                                                                     | ✅  |
| `log_audit`                                         | authenticated    | `is_org_member(p_organization_id)`, unconditional (0002)                                                                                                                   | ✅  |
| `next_movement_number`                              | authenticated    | `is_org_member(p_org_id)`, unconditional (0003)                                                                                                                            | ✅  |
| `store_integration_secret`                          | authenticated    | `has_permission(p_org, 'integrations.manage')` (0012)                                                                                                                      | ✅  |
| `delete_integration_secret`                         | authenticated    | `has_permission(p_org, 'integrations.manage')` (0012)                                                                                                                      | ✅  |
| `match_org_knowledge`                               | authenticated    | `has_permission(p_organization_id, 'copilot.use')` (0007)                                                                                                                  | ✅  |
| `is_assigned_movement`                              | authenticated    | Takes no org id; the body is scoped to `d.user_id = auth.uid()` (0009)                                                                                                     | ✅  |
| `current_user_permissions`                          | authenticated    | Takes an org id but returns only the **caller's own** rows (`m.user_id = auth.uid()`)                                                                                      | ✅  |
| `create_organization_with_owner`                    | authenticated    | Takes no org id — it creates one and makes the caller its Owner (0001)                                                                                                     | ✅  |
| `accept_invitation`                                 | authenticated    | Requires `auth.uid()`, and the token's `invited_email` must equal the caller's email (0001)                                                                                | ✅  |
| `match_regulations`                                 | authenticated    | No org id: the regulation corpus is global, read-only, and identical for every tenant                                                                                      | ✅  |
| `sso_provider_for_email` / `sso_enforced_for_email` | anon (by design) | Unauthenticated by necessity (the login page has no session yet); each returns a single scalar — a provider id or a boolean — and never a row, a member list, or an org id | ✅  |
| `read_integration_secret`                           | service_role     | EXECUTE revoked from `public`, `anon` **and** `authenticated` (0012)                                                                                                       | ✅  |
| `push_tokens_for`                                   | service_role     | EXECUTE granted to `service_role` only (0015)                                                                                                                              | ✅  |
| `claim_jobs`                                        | service_role     | EXECUTE revoked from `public`/`anon`/`authenticated` (0004, 0011, 0013, 0041); the 0041 signature adds `p_organization_id uuid default null`, which `runNow` always sets to the caller's org | ✅  |

Re-runnable:

```sql
select p.proname, p.prosecdef, r.rolname, has_function_privilege('authenticated', p.oid, 'execute')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
join pg_roles r on r.oid = p.proowner
where n.nspname = 'public' and p.prosecdef;
```

The remaining definers in `public` are trigger functions (`movements_guard`,
`movement_children_guard`, `movement_events_guard`, `movement_suggestions_guard`,
`organization_member_role_scope_guard`, `sync_org_subscription`,
`handle_new_auth_user`, `movement_events_immutable`) or the RLS helpers
themselves (`is_org_member`, `has_permission`, `current_user_org_ids`), which
derive everything from `auth.uid()` and are the check rather than a bypass of it.

## 10. Other controls confirmed

- **SSO enforcement fails closed.** `GET /api/auth/sso` is only a hint and fails
  open so a resolver outage cannot take the login page down; the control that
  actually refuses a password on an enforced domain is
  `passwordSignInBlockedFor()` in `apps/web/src/app/(auth)/actions.ts`, backed by
  `apps/web/src/lib/sso.ts` and the 0014 resolvers. The hint route also
  deliberately returns two booleans and nothing that turns a guessed address into
  information about a customer.
- **Audit coverage is enforced by a test.** `packages/api/src/audit-coverage.test.ts`
  asserts that mutating procedures write an audit row, so the trail cannot rot
  silently as routers grow.
- **Per-org job concurrency cap.** `claim_jobs(p_org_cap default 2)`, currently
  defined in `supabase/migrations/0045_claim_jobs_org_cap_fix.sql` (cap since
  0011, leases since 0033, org-scoped claiming since 0041), with
  `FOR UPDATE SKIP LOCKED` leasing, so one tenant's AI burst cannot starve the
  queue. 0045 closed a correctness bug (not a tenant-isolation gap — the cap
  only ever under-enforced within one tenant's own batch, never crossed a
  tenant boundary) where the cap was checked once per batch instead of per
  claimed row, letting a single call claim an organization's entire backlog;
  see `packages/db/src/jobs.integration.test.ts`'s contention and cap tests.
- **Uploads never pass through a function.** `documents.getUploadUrl` mints a
  signed upload URL with the **caller's** session, so Storage RLS applies to the
  upload itself (`packages/api/src/router/documents.ts:69`).
- **`pnpm db:lint` is clean.** `supabase db lint --local --schema public --level
warning --fail-on warning` reports "No schema errors found", and it now runs in
  CI's `integration` job after the migrations apply.

---

## Findings

One live cross-tenant exploit was found and fixed (C1 below). The rest are not
exploitable as the system stands, and are ordered by how much they would matter
if the surrounding assumption ever stopped holding.

**C1 — `notify_organization()` had no caller check: cross-tenant member-email
disclosure and notification injection (critical). FIXED in `eb72589`
(`supabase/migrations/0017_notify_organization_guard.sql`).** The function is
SECURITY DEFINER, `EXECUTE`-granted to `authenticated` (0006, re-created in
0011), takes `p_organization_id` from its caller, returns every matching
member's email address, and inserts into `notifications` — a table
`authenticated` has no INSERT policy on. Any signed-in user could therefore call
it through PostgREST with **another tenant's** organization id and (a) enumerate
that tenant's member emails and (b) plant arbitrary notification rows, with an
arbitrary `link_path`, in those users' inboxes. 0017 re-creates it (converted to
plpgsql) with the guard `record_usage` already used: `is_org_member()` is
re-checked whenever `auth.uid()` is non-null, which leaves the service-role
worker path — which has no JWT and hence no `auth.uid()` — working unchanged.
`anon` also loses the EXECUTE that Supabase's default privileges had granted.
Regression coverage: the "caller guard (0017)" block in
`packages/db/src/notifications.integration.test.ts` asserts SQLSTATE 42501 with
zero rows inserted for a foreign member, and that both a real member and the
service role still succeed. §9b above is the re-audit of every other definer
reachable by `authenticated`; no second instance was found.

**F1 — `/api/jobs/process` is unauthenticated when `CRON_SECRET` is unset
(low). RESOLVED in 5a89236.** `apps/web/src/app/api/jobs/process/route.ts:22-25`
authorised when `!secret && process.env.NODE_ENV !== "production"`, a deliberate
local-dev affordance that the sibling `expiry-scan` route did not share — the
inconsistency being the thing to watch, because someone reading one route would
not expect the other to differ. Both routes now call `cronAuthFailure()` from
`apps/web/src/lib/cron-auth.ts`: an unset secret is a deployment fault (503), a
wrong one is 401 under `timingSafeEqual`, and the build environment is no longer
an authorisation input. Covered by `apps/web/src/lib/cron-auth.test.ts`, which
also asserts neither route reintroduces a `NODE_ENV` branch. The request-tail
worker (`apps/web/src/lib/jobs.ts`) calls `processDueJobs` directly rather than
the route, so local job processing is unaffected.

**F2 — the rate limiter used to fail open (resolved).** `rateLimitFor().check()`
and `checkPublicRateLimit()` now fall back to the per-instance in-memory
sliding window when the Upstash store errors, so a degraded cache lowers the
ceiling to per-instance accuracy rather than removing it. Covered by the
`counts in-process` case in `packages/api/src/ratelimit.test.ts`.

**F3 — `secure` on cookies is conditional on `NODE_ENV` (informational).**
`secure: process.env.NODE_ENV === "production"` is correct for local HTTP work,
but it ties a security flag to a build variable. If a staging deployment ever
runs with `NODE_ENV=development` over HTTPS, the session cookie would be sent in
the clear on any downgrade. Consider keying it on the request protocol or an
explicit env flag.

**F4 — `search_path` is pinned to `public`, not `''` (informational). RESOLVED
in `0032`/`0039`.** Every SECURITY DEFINER function in `public` now sets
`search_path=""` and fully-qualifies its object references — verified directly
against `pg_proc.proconfig` for all 24 (§9) — and `lint-migrations.ts` enforces
it statically for every migration from `0032` onward, so it cannot regress.

**F5 — the anon key is echoed into `load/.sessions.json` (informational).** The
load-test session file holds real access tokens for demo users. It is git-ignored
via `load/.gitignore` and the script refuses nothing but is documented as
local-only; do not point `load/scripts/login.mjs` at a production project.

**F6 — no automated dependency scanning (low).** There is no `pnpm audit`,
Dependabot config, or SCA step in CI. Given the dependency surface (Next 16,
tRPC 11, `ai`, Stripe, Supabase), a weekly `pnpm audit --audit-level=high` job
would be cheap. Out of scope for this task; noted for the backlog.
