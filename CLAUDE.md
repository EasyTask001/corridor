# Corridor — repo-wide agent rules

`CONTRIBUTING.md` is the authority; this file is the short list an agent must not skip.
`apps/web/CLAUDE.md` adds the web-app specifics.

## Database

- **Extend before you add.** Read the live schema (`packages/db/src/schema/` or
  `docker exec supabase_db_Corridor psql -U postgres -d postgres -c '\dt public.*'`) before any
  `create table`. Same grain → add columns. One-to-one → columns unless RLS, size or lifecycle
  differ. Only a genuinely new grain gets a table. Full rule: `CONTRIBUTING.md` → Schema design.
- **Every `create table` carries a "Why a new table" header paragraph**: grain, existing tables
  considered, why each does not fit. Reference: `supabase/migrations/0013_usage_billing.sql`.
- **No key/value bags or `settings jsonb` to avoid a migration.** `jsonb` is for provider
  payloads and free-form metadata only.
- **Denormalised copies need a trigger and an integration test** (`sync_org_subscription()` is
  the model). Never keep two columns in sync from application code.
- **Migrations are the source of truth and are never edited once applied.** New SQL is
  `supabase/migrations/00NN_*.sql`; mirror it in `packages/db/src/schema/`, then run
  `pnpm exec supabase db reset && pnpm db:seed`, `pnpm --filter @corridor/db verify:mirror`,
  `pnpm db:lint`, and `pnpm test:integration`.
- **Every tenant table**: `organization_id ... on delete cascade`, RLS enabled, policies through
  `has_permission()` / `is_org_member()`, and a cross-tenant integration test.

## Everything else

- RLS is the tenant boundary: tenant reads and writes go through `ctx.rls(...)`.
  `withServiceRole()` filters `organization_id` itself and is listed in `docs/security-review.md`.
- Every external service degrades to a deterministic mock when its env var is unset; tests must
  pass with no credentials.
- AI output is never auto-committed; a human applies it.
- Verification before a commit: `pnpm typecheck && pnpm lint && pnpm test`, plus
  `pnpm test:integration` when SQL or the API changed. CI is not run from here; verify locally.
- Conventional commits, one concern per commit, never push without being asked.
