# Corridor — Gap closure to 100% of the platform plan

Spec: `/home/hsthind/.claude/plans/moonlit-mapping-lighthouse.md` (the platform plan). This
document lists every item the 2026-09-06 audit found missing or partial and turns each into a
task. Phases 0–8 are complete and must not regress.

## Global Constraints

- **RLS is the tenant boundary.** Every tenant-table write goes through `ctx.rls(...)` in tRPC
  or `withServiceRole` in workers with an explicit `organization_id` filter. New tables get
  `organization_id`, `enable row level security`, and `to authenticated` policies using
  `has_permission(org_id, key)` / `is_org_member(org_id)` like the existing migrations.
- **No secrets in the browser.** Session cookies stay `httpOnly`. Never return service-role keys,
  provider credentials, or Vault plaintext to a client.
- **AI output is never auto-committed or auto-transmitted.** Human confirmation stays mandatory.
- **Provider fallbacks stay mock-friendly.** Every external service (AI, Redis, Stripe, Resend,
  Vault, SSO) must degrade to a deterministic local mode when its env var is absent so
  `pnpm test`, `pnpm test:integration`, and Playwright run with no external credentials.
- **Migrations are the schema source of truth.** New SQL goes in `supabase/migrations/00NN_*.sql`
  with the number given in the task; Drizzle in `packages/db/src/schema/*` mirrors it (columns,
  FKs, indexes). Apply locally with `pnpm exec supabase db reset && pnpm db:seed` (local Supabase is
  already running on the 553xx ports; never `supabase start` a second instance).
- **Verification bar per task:** `pnpm typecheck`, `pnpm lint`, `pnpm test` pass from repo root;
  `pnpm --filter @corridor/db test:integration` passes when the task touches SQL or `packages/db`.
  Playwright specs must at least compile (`pnpm --filter web exec tsc --noEmit` covers them).
- **Commits:** one or more commits per task on `main`, message ending with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01BLwrPHqnftP8yUPhk4JfSQ`. Never push. Never
  trigger GitHub Actions (billing is disabled; verify locally).
- **Stack versions are fixed:** Next 16 (`src/proxy.ts` is the middleware), `ai@7`, `@ai-sdk/*@4`,
  Drizzle 0.45, Zod 4, Tailwind 4, React 19, tRPC 11. Do not downgrade to match the plan's "v6".
- **Style:** follow existing patterns (Zod schemas in `packages/domain`, services in
  `packages/api/src/services`, routers in `packages/api/src/router`, UI under `apps/web/src`).
  TypeScript strict, no `any` without a comment.

---

## Task 1: Schema gaps, Drizzle drift, per-org job concurrency cap, missing cross-tenant tests

**Migration:** `supabase/migrations/0011_schema_gaps.sql`

1. `alter table notification_rules add column filters jsonb not null default '{}'::jsonb;` and
   mirror in `packages/db/src/schema/notifications.ts`. Expose it through
   `notifications.rules.upsert` input (`filters: z.record(z.string(), z.unknown()).default({})`)
   and `notifications.rules.list` output; the notification-rules settings panel does not need a UI
   for it yet.
2. Rename `notifications.event_type` → `notifications.type` (plan name). Update the Drizzle
   column, `notify_organization()` if it references the column, every TS usage
   (`grep -rn "event_type\|eventType" packages/api apps/web packages/db packages/domain`), and the
   notifications integration test. Keep `notification_rules.event_type` as is (it is a rule
   selector, not the notification type).
3. Indexes: `seals (organization_id)`, `movement_amendments (organization_id)`,
   `notifications (organization_id, created_at desc)`,
   `compliance_alerts (organization_id, created_at desc)`.
4. RLS policies: `movements` DELETE (`has_permission(organization_id, 'movement.write')` and
   `status = 'draft'` — only drafts are deletable), `movement_amendments` DELETE (same permission,
   `status = 'draft'`), `organization_knowledge_embeddings` UPDATE and DELETE
   (`has_permission(organization_id, 'copilot.use')`). Grant the matching table privileges to
   `authenticated`.
5. Drop dead function `public.current_user_org_ids()`.
6. Per-org concurrent AI job cap: `create or replace function public.claim_jobs(p_limit int,
   p_worker text, p_org_cap int default 2)` — a pending job is skipped while its
   `organization_id` already has `>= p_org_cap` rows in `status = 'running'` (jobs with null
   `organization_id` are never capped). Keep `for update skip locked`, SECURITY DEFINER,
   service_role-only execute. Update `packages/api/src/services/jobs.ts` to pass the cap from
   `CORRIDOR_JOB_ORG_CAP` (default 2). Add an integration test in
   `packages/db/src/jobs.integration.test.ts`: with 3 pending jobs for org A and 1 for org B and
   cap 2, one `claim_jobs(10)` call returns 2 A + 1 B; a second call returns nothing for A until
   one finishes.
7. Drizzle drift: add `organizationCounters` table to `packages/db/src/schema/movements.ts`
   (or `core.ts`), the FKs `complianceAlerts.movementId → movements.id` and
   `cargo.sourceDocumentId → sourceDocuments.id`, the HNSW indexes on both embedding columns
   (use `index(...).using("hnsw", table.embedding.op("vector_cosine_ops"))`), and every SQL index
   listed in the audit (`roles_system_name_unique`, `roles_org_name_unique`, `org_user_unique`,
   `org_invite_email_unique`, `audit_log_entity_idx`, drivers `org_license_unique`/`name_search_idx`/
   `org_user_unique`, trucks `org_unit_unique`/`org_vin_unique`, `trailers_org_unit_unique`,
   `partners_name_search_idx`, compliance_alerts partials + `open_dedupe_unique`, movements
   `org_scheduled_idx` + driver/truck/trailer partials, `movement_events_org_idx`,
   `movement_amendments (movement_id, amendment_number)` unique, `cargo_organization_id_idx`,
   `cargo_commodity_search_idx`, `seals_movement_number_unique`, `integration_configs_org_idx`,
   `integration_events_movement_idx`/`correlation_idx`, `background_jobs_due_idx`,
   `source_documents_movement_idx`, `notifications_user_unread_idx`). Read the SQL for exact
   definitions. Use Drizzle's `customType` for `citext` on the four citext columns. Add a comment
   at the top of `packages/db/src/schema/index.ts` stating the mirror is verified against
   migrations 0001–0011.
8. Cross-tenant leak tests: extend `packages/db/src/*.integration.test.ts` so every one of these
   tables has an explicit "Org A user sees zero Org B rows" test: `trailers`, `cargo`, `seals`,
   `movement_amendments`, `integration_events`, `subscriptions`, `notification_rules`,
   `role_permissions` (org B custom role's rows invisible). Follow the existing helper pattern
   (`asUser`/`withRls` fixtures in `rls.integration.test.ts`).

**Acceptance:** `pnpm exec supabase db reset && pnpm db:seed` succeeds; integration suite passes
with the new tests; `pnpm typecheck && pnpm lint && pnpm test` pass.

---

## Task 2: AI client with Vercel AI Gateway + Claude, and rate-confirmation extraction

**Files:** `packages/ai/src/client.ts` (new), `packages/ai/src/index.ts`,
`packages/ai/src/document-intelligence/model-extractor.ts`, `packages/ai/src/copilot/embedder.ts`,
`apps/web/src/app/api/copilot/chat/route.ts`, `packages/domain/src/document.ts`,
`packages/ai/src/document-intelligence/{classify,mock-extractor,pipeline}.ts`,
`packages/ai/src/eval/fixtures/*`, `.env.example`, `turbo.json`, `apps/web/CLAUDE.md`.

1. Add dependency `@ai-sdk/gateway` (latest 4.x compatible with `ai@7`) to `packages/ai` and
   `apps/web`. Create `packages/ai/src/client.ts` exporting:
   - `resolveAiProvider(env = process.env): { kind: "gateway" | "openai" | "none"; ... }` —
     `gateway` when `AI_GATEWAY_API_KEY` is set, else `openai` when `OPENAI_API_KEY` is set,
     else `none`.
   - `languageModel(role: "extraction" | "copilot", env?)` and `embeddingModel(env?)` returning
     AI SDK model instances or `null`. Model IDs env-configurable with these defaults:
     gateway → `CORRIDOR_EXTRACTION_MODEL` default `anthropic/claude-sonnet-4.5`,
     `CORRIDOR_COPILOT_MODEL` default `anthropic/claude-sonnet-4.5`,
     `CORRIDOR_EMBEDDING_MODEL` default `openai/text-embedding-3-small`;
     openai → `gpt-4.1-mini`, `gpt-4.1-mini`, `text-embedding-3-small`.
   - `aiProviderLabel()` for `name` strings (`gateway:anthropic/claude-sonnet-4.5` etc.).
   Gateway auth: `createGateway({ apiKey })`. Embedding dimension stays 1536 (assert in
   `embedder.ts`; `text-embedding-3-small` through the gateway is still 1536).
2. Replace the three direct `createOpenAI` call sites with `client.ts`. `modelExtractorAvailable`,
   `embedderAvailable`, and the chat route's mock branch must use `resolveAiProvider().kind !==
   "none"`. Existing behaviour with only `OPENAI_API_KEY` set must be unchanged (that is the
   developer's current env).
3. Rate confirmation support: extend `extractedDocument` in `packages/domain/src/document.ts` with
   an optional `rateConfirmation` object `{ carrierName, brokerName, referenceNumber, rateAmount,
   rateCurrency ("USD"|"CAD"), pickupAt, deliveryAt, equipment }` (all nullable, plus
   `confidence`). Extraction prompt gets a rate-confirmation section. `classify.ts` must detect
   rate confirmations by content keywords ("rate confirmation", "rate con", "carrier rate") not
   only filename. `mock-extractor.ts` returns a deterministic rate-con object for fixtures
   containing "RATE CONFIRMATION". Add fixture pair
   `packages/ai/src/eval/fixtures/rate-con-produce.{txt,expected.json}` and make the eval score
   rate-con fields. Review workspace (`apps/web/src/app/(app)/documents/[documentId]/review-workspace.tsx`)
   shows the rate-con block read-only when present (no cargo lines are created from it).
4. Unit tests: `packages/ai/src/client.test.ts` covering provider resolution and default model
   IDs for all three states; extend `pipeline.test.ts` for rate-con classification.
5. Update `.env.example` (document `AI_GATEWAY_API_KEY` precedence and the three model vars) and
   `apps/web/CLAUDE.md`/`README.md` AI section.

**Acceptance:** `pnpm test` passes including eval (mock extractor, mean accuracy ≥ 0.9 across 4
fixtures); typecheck/lint clean; with `OPENAI_API_KEY` only, `pnpm --filter @corridor/ai test`
still uses the OpenAI path (verify by unit test, not by calling the API).

---

## Task 3: Upstash Redis — rate limiting tiered by plan, permission-set cache, copilot retrieval cache

**Files:** `packages/api/package.json`, `packages/api/src/infra/redis.ts` (new),
`packages/api/src/infra/ratelimit.ts` (new), `packages/api/src/trpc.ts`,
`packages/api/src/context.ts`, `packages/api/src/services/copilot.ts`,
`apps/web/src/app/api/copilot/chat/route.ts`, `packages/api/src/ratelimit.test.ts` (new),
`.env.example`, `turbo.json`.

1. Add `@upstash/redis` and `@upstash/ratelimit` to `packages/api`. `infra/redis.ts` exports
   `getRedis(): Redis | null` (null when `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`
   are absent) and a tiny `MemoryKv` implementing `get/set(ttl)/incr` for the fallback so all
   cache/rate-limit code has one interface (`KvStore`).
2. `infra/ratelimit.ts`: `rateLimitFor(tier: "standard" | "ai", plan: SubscriptionPlan)` with
   sliding-window limits per plan (standard: trial 60/min, starter 120/min, professional 300/min,
   enterprise 600/min; ai: trial 5/min, starter 20/min, professional 60/min, enterprise 120/min).
   Backed by `@upstash/ratelimit` on Redis, or a sliding-window implementation on `MemoryKv`.
   Key = `${tier}:${orgId}`.
3. `trpc.ts`: add `rateLimited(tier)` middleware; `orgProcedure` applies `standard`, and a new
   `aiProcedure(...permissions)` applies `ai`. Move these to `aiProcedure`:
   `documents.finalizeUpload`, `documents.retry`, `movement.suggestions.generate`,
   `reporting.run`, `copilot.*`. Throw `TRPCError({ code: "TOO_MANY_REQUESTS" })` with a
   `retryAfterSeconds` in `cause`. The copilot chat route applies the `ai` tier itself and returns
   429 with `Retry-After`. The org's plan comes from `organizations.subscription_plan` — load it
   in `createContext` alongside memberships (one extra column on the existing query) and put it on
   `Session` as `plan`.
4. Permission-set cache: in `createContext`, cache the `current_user_permissions` result per
   `(userId, orgId)` for 60s in the KvStore; invalidate (delete the key for every member of the
   org) from `organization.roles.update/delete`, `organization.members.updateRole/setStatus/remove`.
   Provide `invalidatePermissionCache(orgId, userIds)` in `infra/permission-cache.ts`.
5. Copilot retrieval cache: `retrieveContext` caches the regulation-match result per
   `(jurisdiction, normalised query)` for 10 minutes; org-knowledge results are cached per
   `(orgId, normalised query)` for 60s and invalidated when a `copilot.embed_knowledge` job
   completes.
6. Tests: `packages/api/src/ratelimit.test.ts` exercises the memory fallback (limit hit on the
   N+1th call, window resets), the plan tiering, and the permission-cache invalidation using
   `MemoryKv`. Existing `trpc.test.ts` must still pass.
7. `.env.example` + `turbo.json` `globalEnv`: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.

**Acceptance:** unit tests pass; typecheck/lint clean; no behaviour change when Upstash env is
absent except the in-memory limits (which must be high enough that Playwright/e2e never trips:
verify the e2e specs' call counts stay under the trial limits or raise trial limits accordingly).

---

## Task 4: Supabase Vault for integration credentials

**Migration:** `supabase/migrations/0012_vault_credentials.sql`

1. SQL: `create or replace function public.store_integration_secret(p_org uuid, p_provider text,
   p_secret text) returns uuid` — SECURITY DEFINER; checks
   `has_permission(p_org, 'integrations.manage')`; upserts via `vault.create_secret` (or
   `vault.update_secret` when `integration_configs.credentials_ref` already exists for that
   org/provider); sets `integration_configs.credentials_ref`; never returns the secret. Grant
   execute to `authenticated`. `create or replace function public.read_integration_secret(p_org
   uuid, p_provider text) returns text` — SECURITY DEFINER, reads `vault.decrypted_secrets`; execute
   revoked from `authenticated` and `anon`, granted to `service_role` only. `public.delete_integration_secret`
   mirrors store (execute for `authenticated` with the same permission check).
2. `packages/api/src/router/integrations.ts`: `configs.upsert` accepts optional
   `credentials: { apiKey?: string; apiSecret?: string; accountId?: string }`; when present it is
   JSON-serialised and stored through `store_integration_secret` (call the RPC through
   `ctx.supabase.rpc`, never insert into `vault.*` directly); the audit row records only
   `credentials_rotated: true`. New `configs.clearCredentials` mutation. `configs.list` returns
   `hasCredentials: boolean` (credentials_ref not null) and never the secret.
3. `packages/api/src/services/customs.ts`: `customsClientFor` loads the decrypted secret with a
   service-role client (`createClient(url, SUPABASE_SERVICE_ROLE_KEY).rpc("read_integration_secret", ...)`)
   only when `environment = 'production'` and passes it to `createCustomsClient` as
   `credentials` (extend `CustomsClientSettings`/types in `packages/integrations/src/customs/types.ts`;
   the mock client ignores it but records `credentialsPresent` in its `integration_events`
   metadata so tests can assert the plumbing).
4. UI: `apps/web/src/app/(app)/settings/integrations/integrations-panel.tsx` gets API key / secret /
   account ID fields (password inputs, never pre-filled), a "Credentials stored" badge, and a
   "Clear credentials" button. Fix the page copy so it is true.
5. Integration test `packages/db/src/vault.integration.test.ts`: as an org-A owner, store a secret;
   assert `credentials_ref` is set, `read_integration_secret` as service role returns the
   plaintext, as `authenticated` it errors (permission denied), org-B owner cannot read A's secret.

**Acceptance:** migration applies on `db reset`; integration + unit tests pass; typecheck/lint clean.

---

## Task 5: Authenticated Realtime, Supabase Auth webhook, `/movements/new`, optimistic UI, tariff caching

**Files:** `apps/web/src/app/api/realtime/token/route.ts` (new),
`apps/web/src/lib/supabase/use-realtime-client.ts` (new), `apps/web/src/lib/supabase/client.ts`,
`apps/web/src/app/(app)/documents/documents-panel.tsx`,
`apps/web/src/components/notifications/notification-bell.tsx`,
`apps/web/src/components/movement/use-movement-realtime.ts`,
`apps/web/src/app/api/webhooks/supabase-auth/route.ts` (new),
`apps/web/src/app/(app)/movements/new/page.tsx` (new), `apps/web/src/app/(app)/alerts/alerts-list.tsx`,
`apps/web/src/app/(app)/notifications/notifications-list.tsx`,
`packages/api/src/router/integrations.ts` (tariff), `apps/web/src/lib/tariff-cache.ts` (new),
`supabase/config.toml`, `.env.example`.

1. **Realtime auth.** Session cookies remain httpOnly. Add `GET /api/realtime/token` that returns
   `{ token, expiresAt }` for the current cookie session (401 otherwise) — the Supabase access
   token only, never the refresh token. `use-realtime-client.ts` exports `useRealtimeClient()`:
   fetches the token, calls `supabase.realtime.setAuth(token)`, refreshes 60s before expiry, and
   returns the client only once authenticated. All three subscription sites use it. Polling
   fallbacks become reconciliation only: documents panel `refetchInterval` 15s while rows are
   processing, bell 60s, timeline none. Add a comment block explaining why the token route is
   safe (short-lived JWT, same-origin, no refresh token) in the route file.
2. **Supabase Auth webhook.** `POST /api/webhooks/supabase-auth` verifies the
   `SUPABASE_AUTH_WEBHOOK_SECRET` (standard-webhooks signature via header `webhook-signature`;
   implement HMAC-SHA256 verification inline with `crypto`, no new dependency); handles
   `user.created` (upsert `user_profiles`), `user.deleted` (noop, log), and `user.updated` (sync
   `display_name`) using the service-role client. Document the local hook wiring in
   `supabase/config.toml` comments (`[auth.hook.send_email]` is not it; use the
   `auth.webhook` style comment block) and `.env.example`.
3. **`/movements/new`.** Server Component page with two cards (ACE southbound / ACI northbound)
   each a form posting the existing `createMovement` server action with the regime; redirect to
   the new movement's workspace. Link "New movement" from the movements list to `/movements/new`
   (keep the existing inline buttons working). Gate on `movement.write` like the list does.
4. **Optimistic UI.** `alerts-list.tsx` status changes and `notifications-list.tsx` /
   `notification-bell.tsx` mark-read use TanStack Query `onMutate` with rollback on error and
   `onSettled` invalidation. Movement workspace note-add appends the note optimistically.
5. **Tariff caching.** tRPC runs in `packages/api`, so Next's `unstable_cache` is not usable
   there. Add an in-process TTL cache in `packages/integrations/src/tariff.ts`
   (`TARIFF_CACHE_TTL_MS` default 24h, keyed by normalised query) in front of
   `lookupHsCode`/`searchTariff`, and set `export const revalidate = 86400` on any RSC page that
   renders tariff data (currently none; if none exists, say so in the report). Add a unit test
   that the second lookup within TTL does not call the underlying search (use an injectable
   clock/search fn). Drop the `apps/web/src/lib/tariff-cache.ts` file from the file list.

**Acceptance:** typecheck/lint/test pass; Playwright `documents.spec.ts` and
`risk-and-notifications.spec.ts` still pass locally against the dev server (run them:
`pnpm --filter web exec playwright test e2e/documents.spec.ts e2e/risk-and-notifications.spec.ts`).

---

## Task 6: `packages/ui` — shadcn-style component library, design tokens, TanStack Table

**Files:** `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/eslint.config.js`,
`packages/ui/src/index.ts`, `packages/ui/src/tokens.css`, `packages/ui/src/lib/cn.ts`,
`packages/ui/src/components/{button,badge,input,select,textarea,label,card,dialog,table,data-table,tabs,skeleton,alert}.tsx`,
`packages/ui/src/data-table.test.tsx`, `apps/web/package.json`, `apps/web/src/app/globals.css`,
`apps/web/src/components/registry/registry-page.tsx`, `apps/web/src/app/(app)/movements/page.tsx`,
`apps/web/src/app/(app)/settings/audit/audit-list.tsx`, `apps/web/src/app/(app)/alerts/alerts-list.tsx`.

1. Create `@corridor/ui` as a source-exported workspace package (`"exports": {".": "./src/index.ts",
   "./tokens.css": "./src/tokens.css"}`, `peerDependencies` react 19, deps `clsx`,
   `tailwind-merge`, `class-variance-authority`, `@tanstack/react-table`, `@radix-ui/react-dialog`,
   `@radix-ui/react-tabs`, `@radix-ui/react-select`, `@radix-ui/react-label`, `lucide-react`).
   Components follow shadcn/ui conventions (cva variants, `cn`, forwardRef where relevant) and
   use the Corridor tokens (`ink-*`, `signal-*`, `ok/warn/danger`).
2. Move the `@theme` token block from `apps/web/src/app/globals.css` to `packages/ui/src/tokens.css`
   and `@import "@corridor/ui/tokens.css"` from `globals.css`; add `@source "../../../../packages/ui/src"`
   so Tailwind 4 scans the package.
3. `DataTable<TData>` built on TanStack Table: column defs, sorting, optional global filter,
   optional row click, empty state, and a `renderRow` escape hatch. Server-side pagination props
   (`pageIndex`, `pageSize`, `total`, `onPageChange`).
4. Adopt in four places: `registry-page.tsx` (replace the hand-rolled table), movements list,
   audit list, alerts list. Behaviour, column set, and test ids/labels used by Playwright must be
   preserved (grep the e2e specs for the text they assert on before changing markup).
5. Vitest + React Testing Library test for `DataTable` (renders rows, sorts on header click,
   shows empty state). Add `@testing-library/react`, `jsdom` to `packages/ui` devDeps and set
   `environment: "jsdom"` in its vitest config.
6. Wire `packages/ui` into turbo (`lint`, `typecheck`, `test` scripts) and the root README layout table.

**Acceptance:** `pnpm typecheck && pnpm lint && pnpm test && pnpm turbo run build --filter=web`
pass; Playwright `registries.spec.ts` and `movements.spec.ts` pass locally.

---

## Task 7: Audit-log completeness and usage-based billing

**Migration:** `supabase/migrations/0013_usage_billing.sql`

1. **Audit completeness.** Every mutation writes `audit_log` through `writeAudit` (existing
   `packages/api/src/services/audit.ts`): all `movement.*` mutations (create, update, cargo
   upsert/remove, seals add/remove, addNote, submit, cancel, markArrived, amend, customsResponse,
   suggestions accept/dismiss), `alerts.rescan`, `notifications.rules.upsert`, `billing.checkout`
   and `billing.portal` (action `billing.session_opened`), the Stripe webhook's subscription
   changes (actor_id null, action `billing.subscription_synced`, via service role), and
   `documents.finalizeUpload`. `before`/`after` carry the changed row (redact nothing sensitive is
   needed here; there are no secrets in those rows). Add `packages/api/src/audit-coverage.test.ts`:
   a static test that walks every router's mutation procedure names (from `appRouter._def`) and
   asserts each one appears in an `AUDITED_MUTATIONS` allow-list you maintain in
   `services/audit.ts`, so a future unaudited mutation fails the build.
2. **Usage metering.** Table `usage_records(id bigint identity, organization_id uuid, metric text
   check in ('documents_extracted','copilot_messages','movements_transmitted','ai_suggestions'),
   quantity int, occurred_at timestamptz, period_start date, stripe_meter_event_id text, reported_at
   timestamptz, metadata jsonb)` + index `(organization_id, period_start, metric)` + RLS
   select for `billing.manage`; writes via SECURITY DEFINER `record_usage(p_org, p_metric, p_qty,
   p_metadata)` granted to `authenticated` (it verifies `is_org_member`). Drizzle mirror.
   `packages/api/src/services/usage.ts`: `recordUsage(tx|supabase, orgId, metric, qty, meta)`; call
   it from the document extraction job on success, the copilot chat route per completed
   assistant message, `movement.submit`, and `movement.suggestions.generate`.
3. **Stripe meter reporting.** `packages/integrations/src/stripe.ts`: `reportUsage(records)` using
   `stripe.billing.meterEvents.create` with `event_name` from
   `STRIPE_METER_<METRIC>` env (falls back to the metric name); in mock mode it returns synthetic
   IDs. Worker job type `billing.report_usage` in `services/jobs.ts` that reports unreported
   records for the previous hour and stamps `reported_at`/`stripe_meter_event_id`; enqueue it from
   the `/api/jobs/expiry-scan` cron handler (daily is fine; rename nothing).
4. **Plans.** `BILLING_PLANS` gets `usage: { includedDocuments, includedCopilotMessages,
   overageUsdPerDocument, overageUsdPerMessage }` (starter 50/200/1.50/0.10, professional
   500/2000/1.00/0.05, enterprise unlimited = null). `billing.status` returns the current period's
   usage per metric and projected overage. `billing-panel.tsx` shows a "Usage this period" table
   with included vs used and projected overage.
5. Tests: unit tests for `usage.ts` (projected overage maths) and the meter reporter in mock mode;
   integration test that `record_usage` as an org-A member inserts and org-B cannot read it.

**Acceptance:** `pnpm test`, integration suite, typecheck/lint pass; `audit-coverage.test.ts`
proves every mutation is audited.

---

## Task 8: SSO / SAML (enterprise)

**Migration:** `supabase/migrations/0014_sso.sql`

1. Table `organization_sso(organization_id uuid pk, provider_id text not null, domains text[] not
   null, enforced boolean default false, created_at, updated_at)` with RLS (`billing.manage` or
   `org.manage` — pick the existing org-settings permission and reference it) plus a public
   SECURITY DEFINER `sso_provider_for_email(p_email citext) returns text` (execute to `anon`) that
   maps an email domain to a `provider_id` so the login page can route SSO users without a
   session. Drizzle mirror.
2. `packages/integrations/src/sso.ts`: thin wrapper over Supabase Auth Admin SSO API
   (`supabase.auth.admin`: `createSSOProvider`/`updateSSOProvider`/`deleteSSOProvider`), plus a
   mock mode when the local instance reports SAML disabled (catch the specific error, return a
   synthetic provider id prefixed `mock-sso-`). Enable `[auth.external.saml] enabled = true` in
   `supabase/config.toml` if the CLI version supports it (check `pnpm exec supabase --version`;
   if the key is rejected, leave it commented with a note).
3. tRPC `organization.sso.{get,configure,remove}` (enterprise plan only — `FORBIDDEN` otherwise;
   plan comes from `ctx.session.plan` added in Task 3). `configure` input: `metadataUrl` or
   `metadataXml`, `domains[]`, `enforced`. Audit every change.
4. UI: `settings/organization` gets an "Single sign-on (SAML)" section (metadata URL, domains,
   enforce toggle, status). Login page: after the email is typed, on blur call a public route
   `GET /api/auth/sso?email=` that uses `sso_provider_for_email`; if a provider exists show
   "Continue with SSO" which calls `supabase.auth.signInWithSSO({ domain })` client-side and
   redirects to the returned URL. When `enforced`, hide the password field for that domain.
5. Tests: unit test the wrapper's mock path and the email→domain mapping; integration test that
   `sso_provider_for_email` resolves a seeded domain and RLS hides `organization_sso` across orgs.

**Acceptance:** migration applies; tests, typecheck, lint pass; `foundations.spec.ts` login flow
still passes locally.

---

## Task 9: Security review, DB lint, load tests, CI coverage

**Files:** `docs/security-review.md` (new), `.github/workflows/ci.yml`, `load/` (new),
`package.json`, `README.md`.

1. **Security review document** `docs/security-review.md`: checklist with evidence links for the
   plan's §10 items — no client-exposed JWTs/passwords (cite proxy.ts/server.ts cookie flags and
   the Task 5 token route rationale), no card data (Stripe hosted), cookies httpOnly+secure+sameSite,
   RLS on every table (generate the table list from migrations and tick each), Vault for provider
   credentials, rate limiting, webhook signature verification (Stripe + Supabase Auth), service-role
   key usage sites (grep and list them). Include a "Findings" section with anything you notice.
2. **DB lint:** root script `db:lint` → `supabase db lint --local --level warning --fail-on warning`
   (check the exact flags for the installed CLI). Add it to the CI integration job after
   migrations apply. Run it locally and fix any warnings it reports (security-definer search_path,
   RLS-disabled tables, etc.). Also add `db:advisors` script that runs
   `supabase inspect db` reports if available, otherwise omit.
3. **Load testing:** `load/README.md`, `load/k6/movements-list.js`, `load/k6/realtime-fanout.js`,
   `load/k6/bulk-upload.js`. Scripts take `BASE_URL`, `ORGS`, `DISPATCHERS_PER_ORG`, and a session
   cookie file produced by `load/scripts/login.mjs` (uses the seeded demo users). Thresholds:
   p95 < 500ms for movement list, job queue drains 100 uploads within 5 minutes. Do not add k6 as
   a dependency; document installation.
4. **CI:** add a `e2e` job (needs `integration`) that starts local Supabase, seeds, builds web,
   runs `playwright test` with `PLAYWRIGHT_BASE_URL` against `next start`, uploads the report
   artifact on failure. Add a `preview` job that runs `vercel deploy --prebuilt` when
   `secrets.VERCEL_TOKEN` is present (`if: ${{ secrets.VERCEL_TOKEN != '' }}` is not valid — use
   an env indirection job output) and comments the URL on PRs. Add a `model-eval` job that runs
   `CORRIDOR_EVAL_EXTRACTOR=model pnpm --filter @corridor/ai test -- eval` only when files under
   `packages/ai/src/document-intelligence/**`, `packages/domain/src/document.ts`, or
   `packages/ai/src/eval/**` changed (use `dorny/paths-filter`) and an AI key secret exists. Keep
   the workflow syntactically valid (`actionlint` if available via `npx`—otherwise careful review).
   Do NOT trigger any run.

**Acceptance:** `pnpm db:lint` passes locally with zero warnings; workflow file validates;
`docs/security-review.md` is complete with file references.

---

## Task 10: Test coverage — API unit tests with mocked DB, e2e copilot + invite acceptance, seed docs and alerts

**Files:** `packages/api/src/router/*.test.ts` (new), `apps/web/e2e/copilot.spec.ts` (new),
`apps/web/e2e/foundations.spec.ts`, `packages/db/scripts/seed.ts`, `supabase/seed.sql` if
regenerated, `apps/web/e2e/fixtures/*`.

1. **API procedure unit tests with a mocked DB.** Add a `packages/api/src/test/mock-context.ts`
   helper that builds a `Context` with a stubbed `rls` (an in-memory fake `tx` exposing the
   Drizzle methods the procedure uses, built with `vi.fn()`), a fake session with chosen
   permissions and plan, and a `createCaller` wrapper. Cover: `movement.submit` (rejects when
   validation fails, transitions when valid, writes an event + audit), `movement.cancel`,
   `alerts.setStatus` (permission enforced, audit written), `documents.applyExtraction` (rejects
   when the document is not `extracted`, creates cargo lines from the same domain schema),
   `reporting.run` (unsupported question error surfaces as BAD_REQUEST), `organization.members.invite`
   (seat limit for the plan). At least 12 tests total.
2. **Copilot e2e** `apps/web/e2e/copilot.spec.ts`: login as compliance user, ask "What documents
   are required for an ACE e-manifest?", assert a streamed answer appears and at least one
   citation chip links to a seeded regulation title (mock provider path must produce citations —
   verify with the existing mock chat behaviour and fix if it does not). Second test: read-only
   user without `copilot.use` gets the "not available" state.
3. **Invite acceptance e2e:** extend the owner-invite test to open the invite link in a fresh
   context, sign up as the invitee with the same email, accept, and assert the members table shows
   `active` for that email.
4. **Seed:** add two `source_documents` rows for the demo org (one `extracted` BOL with
   `extracted_json` from the `bol-steel-coils` fixture, one `failed` invoice) and three
   `compliance_alerts` rows spanning `open`/`acknowledged`/`resolved` (types `document_expiry`,
   `risk_flag`, `hs_code_mismatch`). Keep the seed idempotent (guard by `original_filename` and
   `dedupe_key`). Regenerate `supabase/seed.sql` if the generator covers these tables; otherwise
   leave `seed.sql` untouched and note it.

**Acceptance:** `pnpm test` passes with the new API tests; `pnpm db:seed` twice in a row is a
no-op the second time; the new/changed Playwright specs pass locally.

---

## Task 11: Mobile — Expo driver app scaffold sharing `packages/domain` and tRPC

**Files:** `apps/mobile/**` (replace the README placeholder), `pnpm-workspace.yaml` (already
includes `apps/*`), root `README.md`, `turbo.json` if scripts are added.

1. Scaffold `apps/mobile` with Expo SDK 54 + expo-router (`package.json` name `@corridor/mobile`,
   scripts `start`, `typecheck`, `lint`, `test`), `app.json`, `tsconfig.json` extending
   `@corridor/config/tsconfig/base.json`, `babel.config.js`, `metro.config.js` configured for the
   pnpm monorepo (watchFolders = repo root, `disableHierarchicalLookup`). Do not run a build or
   emulator; `pnpm --filter @corridor/mobile typecheck` must pass.
2. Auth: `src/lib/supabase.ts` with `expo-secure-store` storage adapter; `src/lib/trpc.ts` using
   `@trpc/client` `httpBatchLink` to `${EXPO_PUBLIC_API_URL}/api/trpc` with
   `Authorization: Bearer <access token>` and `x-corridor-org` headers, `superjson` transformer,
   typed with `AppRouter` from `@corridor/api` (type-only import).
3. Screens (expo-router): `app/(auth)/sign-in.tsx`, `app/(driver)/index.tsx` (assigned movements
   via `movement.list` — Driver-Portal reads), `app/(driver)/movement/[id].tsx` (status, crossing,
   timeline), `app/(driver)/movement/[id]/capture.tsx` (camera/image picker → `documents.getUploadUrl`
   → direct PUT to the signed URL → `documents.finalizeUpload` with `documentType`), 
   `app/(driver)/movement/[id]/pod.tsx` (signature pad using `react-native-signature-canvas` or an
   SVG path capture; uploads as `document_type: 'other'` with `original_filename: pod-signature.png`),
   `app/(driver)/notifications.tsx` (`notifications.list` + `markRead`).
4. Offline outbox: `src/lib/outbox.ts` — queue of pending mutations persisted with
   `@react-native-async-storage/async-storage`, each validated against the `packages/domain`
   Zod input schema before enqueue and before replay; replay on reconnect
   (`@react-native-community/netinfo`). Unit test the outbox with Vitest (pure TS, no RN imports in
   the module under test).
5. Push notifications: `src/lib/push.ts` registers an Expo push token and stores it through a new
   `notifications.registerDevice` tRPC mutation (table `user_devices(user_id, organization_id,
   expo_push_token, platform, created_at)` in `supabase/migrations/0015_user_devices.sql` with
   user-scoped RLS). The web worker's notification fan-out (`services/notifications.ts`) sends an
   Expo push (`https://exp.host/--/api/v2/push/send`, no SDK dependency, mock when
   `EXPO_PUSH_ENABLED` is unset) for channel `push`.
6. Update root README (mobile quick start) and `apps/mobile/README.md`.

**Acceptance:** `pnpm install` succeeds without peer-dependency errors that break the web app;
`pnpm typecheck` (all packages incl. mobile) and `pnpm lint` pass; `pnpm test` passes including
the outbox test; integration test for `user_devices` RLS passes; web build still passes.
