# Changelog

All notable changes to Corridor are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/), versioning follows
[SemVer](https://semver.org/). Nothing has been tagged yet — everything below is unreleased, and
the section headings are the build phases, not versions.

## [Unreleased]

### Added

- `@corridor/ui` — shadcn-style component library, design tokens, TanStack Table `DataTable`.
- Expo driver app (`apps/mobile`): the same tRPC router over `Authorization: Bearer`, an offline
  outbox, and Expo push registration (`user_devices`, migration 0015).
- Targeted `movement.assigned` notification: assigning a driver notifies that driver (and only
  that driver), the one event type a Driver-Portal member can receive.
- Push delivery as a background job (`notification.push`, migration 0016) so the producer never
  takes a service-role connection while a caller's RLS transaction is open.
- Upstash Redis: rate limiting tiered by plan, a short-lived permission-set cache, and a copilot
  retrieval cache (regulations 10 min, org knowledge 60 s).
- Supabase Vault for integration credentials, reachable only through
  `store_/delete_/read_integration_secret`.
- Authenticated Realtime through a short-lived token endpoint, plus the Supabase Auth webhook.
- `/movements/new`, and optimistic UI for alerts and notifications.
- Usage metering (`usage_records`, migration 0013) with a Stripe meter-reporting job.
- SSO / SAML for the Enterprise plan (`organization_sso`, migration 0014).
- Audit-log completeness: `AUDITED_MUTATIONS` / `AUDIT_EXEMPT_MUTATIONS` classify every mutation
  in the router, enforced by `packages/api/src/audit-coverage.test.ts`, with a settings/audit
  viewer.
- Cross-tenant leak tests for every tenant table, and `verify:mirror`, which proves the Drizzle
  schema still matches the live database.
- Port master and multi-carrier codes (`ports`, `organization_carrier_codes`, migration 0018):
  validated, searchable CBP/CBSA port-of-entry, CBSA office, in-bond destination, FIRMS and
  sublocation codes replace the free-form `movements.crossing_point` jsonb blob.
- Shipments as a first-class entity (`shipments`, migration 0019): the PAPS/PARS/bill filing unit,
  created and searched independently of the movement it eventually rides on; `cargo` moves to
  `commodities` (with `commodity_hazmat` for up to three dangerous-goods declarations per line).
- Multi-person crew and travel documents (migration 0020): `movement_crew` replaces
  `movements.driver_id` (a crossing carries a crew, not one driver), `driver_documents` replaces
  `drivers.fast_card_*`, and `drivers` gains person type, gender, hazmat endorsement and a US
  address.
- Multi-trailer equipment detail (migration 0021): `equipment_types` (CBP/CBSA equipment codes),
  `equipment_plates`, and `movement_trailers` (a crossing pulls one, two or zero trailers) replace
  `movements.trailer_id`; seals move to per-trailer-slot, capped at 4 per trailer and 1 per truck.
- Manifest flags and customs event vocabulary (migration 0022): the ACE IIT indicator, the five
  ACI trip flags (LVS, postal, flying truck, in-transit, IIT), CBSA ECCRD amendment reason codes,
  and per-shipment `customs_event` rows on the movement timeline.
- Customs gateway live filing (`customs_submissions`, `carrier_notices`, migration 0023):
  `integration_configs.mode` (`mock` | `gateway`) switches between the deterministic simulator and
  a certified EDI gateway's REST API; submissions are keyed by the gateway's reference number so
  an inbound webhook can resolve them.
- Generated documents (`generated_documents`, migration 0024): every PDF Corridor renders (driver
  sheets, blank driver sheets, manifest summaries, reports, registry exports) is tracked in
  Storage, plus `organizations.simple_driver_sheet` for Avaal's commodity-line-free sheet.
- SMS channel and company profile (migration 0025): driver SMS opt-in per regime,
  `user_profiles.phone`, org timezone/billing address/dispatch e-mails, and the "include PARS in
  cargo control numbers" filing rule.
- In-bond monitor (`external_shipments`, `in_bond_records`, `in_bond_events`, migration 0026):
  IT/TE/IE moves for Corridor's own shipments and for goods another carrier filed, tracked from
  arrival to export or closure.
- PARS RNS feed and public tracking (`pars_rns_events`, migration 0027): CBSA Release Notification
  System messages, plus `lookup_shipment_status()` — the single, minimal, service-role-only read
  behind the public PAPS/PARS tracking page.
- CSV bulk import (`import_batches`, migration 0028): validate-then-commit import of shipments or
  commodity lines from a CSV/TXT/DAT file, with a per-line report; `text/csv` added to the
  `documents` bucket's allow-list (migration 0029).
- `docs/user-manual/`: an 8-page in-app user manual, linked from a new Resources page.
- List toolbar: search by column, page size, auto-refresh and bulk actions on every registry list.
- Design system foundation (`design/foundation-v2`): primitive/semantic design tokens with dark
  mode, a FOUC-safe `ThemeToggle`, and every `@corridor/ui` primitive reskinned onto the new
  tokens (button, badge, alert, table, card, tabs, data-table, input, select, dialog, checkbox,
  radio, switch, tooltip); the app shell nav was consolidated into grouped, icon-led sections.
- BorderConnect eManifest API (migration 0047): a third customs filing mode, `border_connect`,
  alongside `mock`/`gateway` — one Service Provider account (EasyTask) files ACE/ACI e-manifests
  for every tenant, told apart by `organizations.border_connect_company_key`. Outbound `ACE_TRIP`/
  `ACI_TRIP` mapping, a durable shared `customs_inbox` drained every minute
  (`api/jobs/borderconnect-drain`) into movement status/RNS/system-alert updates, a standalone
  WebSocket listener (`apps/borderconnect-listener`, hosting deferred), a ready-to-cross readiness
  panel, and `packages/integrations/scripts/borderconnect-smoke.ts` — a live smoke test against
  the real BorderConnect account (`autoSend: false`, never reaches CBP) designed to settle what
  `GET /api/receive` actually returns, not yet run against a real account (it needs a test
  `companyKey` nobody has supplied — see the BorderConnect README's "Open risks").

### Changed

- Migration 0011: schema gaps, missing indexes and write policies, per-org job concurrency cap.
- Migration 0012: Vault credential functions.
- Migration 0013: `usage_records` + `record_usage()`, and `claim_jobs()` gains a lease so a job
  left `running` by a crashed worker is reclaimable, or retired to `failed` once out of attempts.
- Migration 0014: `organization_sso` + the two email→provider resolvers.
- Migration 0015: `user_devices` (Expo push tokens; `push_tokens_for` is service-role only).
- Migration 0016: the insert policy the `notification.push` producer needs.
- Migration 0017: a caller check on `notify_organization()` (see Security).
- Migrations 0018–0029: ports/carrier codes, shipments, crew/equipment, customs gateway,
  generated documents, in-bond, PARS RNS and CSV import (see Added).
- Migration 0030: indexes `organization_members.role_id` and `role_permissions.permission_id` —
  a db-lint pass against the `supabase-postgres-best-practices` guidelines found both had zero
  index coverage (only the leading column of an existing composite/PK was covered), the first
  used in a direct `JOIN`, the second on the FK a permission-delete cascade actually walks. Two
  other candidates from the same raw "unindexed FK" scan (`drivers.user_id`,
  `notification_rules.user_id`) turned out to already be covered by existing composite/partial
  unique indexes once checked against real query shapes — not touched.
- Drizzle schema mirror verified against migrations 0001–0030.
- Web app pages and the Expo driver app restyled onto the new design tokens, across dashboard,
  documents, alerts, copilot, in-bond and the mobile sign-in, movement and capture screens.
- AI extraction and copilot run on Claude Sonnet 4.5 when `AI_GATEWAY_API_KEY` is set, on OpenAI
  direct when only `OPENAI_API_KEY` is, and on the deterministic mock with neither.
- SSO: only `configure` requires the Enterprise plan. `get` and `remove` need just
  `organization.manage`, so a downgraded tenant can still turn off enforcement rather than being
  locked out of password sign-in.
- `copilot.capabilities` and `copilot.regulations.list` moved off the `ai` rate-limit tier — they
  never call a model.
- The Stripe usage reporter no longer holds a transaction across its HTTP calls: it reads the
  batch, calls Stripe with nothing open, then stamps the rows.

### Fixed

- Drizzle drift: missing tables, foreign keys, HNSW indexes and citext columns.
- Missing RLS DELETE policies for movements and amendments (drafts only).
- Dead function `current_user_org_ids()` dropped (0011).
- `notifications.event_type` renamed to `notifications.type` (0011).
  `notification_rules.event_type` is unchanged — it is the rule _selector_, not the row's type.
- Expo tickets reporting `DeviceNotRegistered` now delete the `user_devices` row, so dead tokens
  are pruned instead of being retried forever.
- Shipments could get stuck in `draft` through a full customs cycle; fixed.
- PARS/RNS date filter used a raw SQL template instead of `gte()`, which broke on some driver
  values.

### Security

- **2026-09-11 audit remediation.** All 41 findings from the 2026-09-11 security/quality audit
  (`docs/AUDIT-2026-09-11.md`) have been resolved — see the `**Resolution:**` line under each
  finding there for the fixing commit(s). Highlights: the CRITICAL cross-tenant leak in
  `integrations.jobs.runNow` (now scoped to the caller's org via `claim_jobs`'s new
  `p_organization_id` parameter, migration 0041, and returning counts only); four jsonb address
  columns replaced with flat text columns (migration 0042); tenant-scoped, bounded fixture state
  for the customs mock/gateway clients; the rate limiter's Redis-outage fallback closed (no longer
  fails open); and type-aware ESLint (`recommendedTypeChecked`) rolled out monorepo-wide (partial
  by a recorded controller ruling — 10 rule families remain a tracked follow-up). See
  `docs/security-review.md` for the updated service-role and RLS posture.
- **Cross-tenant fix.** `notify_organization()` is SECURITY DEFINER and granted to
  `authenticated`, and took an organization id from its caller without checking membership: any
  signed-in user could read another tenant's member emails and plant notifications in their
  inboxes. Migration 0017 adds the membership guard (skipped when there is no `auth.uid()`, so
  the service-role worker still works) and revokes `anon`'s EXECUTE. See finding C1 in
  `docs/security-review.md`.
- **Cross-tenant job execution via `testCustoms`/the BorderConnect cron.** Both enqueue their own
  `customs.borderconnect_drain` job (queue-wide, `organization_id` null) and then call
  `processDueJobs` — before migration 0048 this claim was unscoped (`p_organization_id` cannot
  scope a job with no organization), so one click or cron tick could claim and execute up to
  `limit` other tenants' unrelated due jobs under that caller's worker name. `claim_jobs` gains
  `p_job_id` (0048); both callers now pass `jobId: job.id, limit: 1` and can never claim anything
  but the job they just enqueued. Also fixed in the same pass: a sandbox org going live on
  BorderConnect the moment the deployment's env vars were configured
  (`isBorderConnectLive` now also requires `environment === "production"`); a rejected amendment
  flipping the original, already-accepted filing's status too (`applyStatusMessage` now updates
  by submission id, not just `(org, reference_number)`); and an ACE release code with no
  accompanying trip-level decision never advancing the shipment's own status.
- Cron routes fail closed: `/api/jobs/process` and `/api/jobs/expiry-scan` both go through
  `cronAuthFailure()` — an unset `CRON_SECRET` is a 503, a wrong one a 401 under
  `timingSafeEqual`, and `NODE_ENV` is no longer an authorisation input.
- Every provider credential lives in Supabase Vault, never in a plaintext column.
- The service-role key is used only in server-side workers and webhooks; its call sites are
  enumerated in `docs/security-review.md` §8.
- Rate limiting on org-scoped tRPC procedures (standard tier), with a tighter `ai` tier for the
  procedures that invoke a model.
- Webhook signature verification for Stripe and the Supabase Auth hook.
- Realtime tokens are short-lived and refreshed client-side; no refresh token is exposed.

---

## Phases 0–8 — initial build (2026-09-06)

### Added

- Next.js 16 App Router + tRPC 11 + React 19 on Supabase Postgres, with RLS as the tenant
  boundary.
- Document extraction pipeline (BOL, commercial invoice, rate confirmation) with human review
  before anything is applied.
- Compliance copilot: chat with retrieval over an ingested regulation corpus, with citations.
- Movement lifecycle as a server-enforced state machine
  (`draft → sent → accepted → released → arrived`, with `rejected`, `held` and `cancelled`).
- Compliance alerts: document expiry, risk scoring, hold prediction.
- Notifications: per-user rules, channels, realtime inbox.
- Organization settings: roles and custom roles, members, invitations, billing.
- Stripe subscriptions (trial, starter, professional, enterprise).
- Driver-Portal role and seeded demo data for two tenants.

### Infrastructure

- Turborepo + pnpm workspaces (`apps/web`, `apps/mobile`, `packages/*`).
- Local Supabase on the 553xx port range (`supabase/config.toml`).
- Vitest unit and integration suites, Playwright end-to-end suite.

---

## Versioning policy

- **Major**: breaking API changes, or migrations needing manual intervention.
- **Minor**: new features, backward-compatible schema additions.
- **Patch**: bug fixes, dependency updates, docs.

Pre-1.0 versions may break in minor releases.

## Migration notes

Migrations are never edited once applied; a correction is always a new file. After pulling
changes that touch `supabase/migrations/`, run:

```bash
pnpm exec supabase db reset && pnpm db:seed
pnpm --filter @corridor/db verify:mirror
```

[Unreleased]: https://github.com/EasyTask001/corridor/commits/main
