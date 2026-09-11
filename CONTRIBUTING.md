# Contributing to Corridor

Thank you for contributing! This guide covers the workflow, standards, and tooling.

## Getting Started

1. **Fork & Clone**

   ```bash
   git clone https://github.com/<your-fork>/corridor.git
   cd corridor
   pnpm install
   ```

2. **Set Up Local Environment**

   ```bash
   cp .env.example .env.local          # repo root: scripts, seeds, integration tests
   cp .env.example apps/web/.env.local # the Next.js app reads its own
   pnpm db:start                       # local Supabase on the 553xx ports
   pnpm exec supabase status -o env    # fill in ANON_KEY / SERVICE_ROLE_KEY
   pnpm db:seed
   pnpm dev
   ```

   Every third-party key is optional — with none of them set, AI, Stripe, email, push and the
   customs gateways all run as deterministic local mocks.

3. **Verify Setup**
   ```bash
   pnpm typecheck && pnpm lint && pnpm test
   ```

## Development Workflow

### Branching

- `main` — Protected, deployable at all times
- `feature/<short-kebab-case>` — New functionality
- `fix/<short-kebab-case>` — Bug fixes
- `chore/<short-kebab-case>` — Maintenance, deps, tooling
- `docs/<short-kebab-case>` — Documentation only

### Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add rate confirmation extraction
fix: handle null organization_id in claim_jobs
chore: upgrade to Next.js 16.3
docs: update mobile README
refactor: extract tariff caching to integrations
```

**Commit message format:**

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **Scope**: `web`, `api`, `db`, `ai`, `auth`, `domain`, `ui`, `mobile`, `integrations`
- **Subject**: Imperative mood, lowercase, no period
- **Body**: Explain _why_, not _what_ (the diff shows what)
- **Footer**: `Co-Authored-By:`, `Claude-Session:`, `Closes #<issue>`

### Pull Requests

1. **Title**: Same format as commit subject
2. **Description**: fill in `.github/PULL_REQUEST_TEMPLATE.md`, which GitHub pre-populates —
   what changed and why, testing performed, migration notes if the schema changed, screenshots
   for UI changes
3. **Checks**: All must pass (typecheck, lint, test, build)
4. **Review**: At least one approval required

## Code Standards

### TypeScript

- Strict mode enabled — no `any` without `// @ts-expect-error` comment
- Prefer `interface` for object shapes, `type` for unions/primitives
- Use Zod schemas in `@corridor/domain` as source of truth; infer TS types via `z.infer<typeof schema>`
- Explicit return types for public APIs

### Project Structure

| Layer          | Location                      | Responsibility                                       |
| -------------- | ----------------------------- | ---------------------------------------------------- |
| Domain         | `packages/domain/src/`        | Zod schemas, permissions, state machines, pure types |
| Database       | `packages/db/src/schema/`     | Drizzle tables mirroring migrations                  |
| Services       | `packages/api/src/services/`  | Business logic, external API calls, jobs             |
| Routers        | `packages/api/src/router/`    | tRPC procedures, input validation, authz             |
| UI Components  | `packages/ui/src/components/` | Reusable, design-system components                   |
| App Components | `apps/web/src/components/`    | Feature-specific, composed from UI kit               |
| Pages          | `apps/web/src/app/(app)/`     | Server Components, Server Actions                    |

### Database

- **Migrations are source of truth** — `supabase/migrations/00NN_*.sql`
- Drizzle in `packages/db/src/schema/` mirrors migrations exactly
- Every tenant table: `organization_id uuid REFERENCES organizations(id)`, `enable row level security`
- RLS policies use `has_permission(org_id, 'key')` / `is_org_member(org_id)`
- Run `pnpm db:lint` before committing migrations
- `pnpm --filter @corridor/db lint` (also run via `pnpm lint`) statically checks every migration
  numbered ≥0032 for `security definer` functions missing `set search_path = ''` or set to
  `public` — `pnpm db:lint` (Supabase's linter) only catches a missing `search_path`, not one
  pinned to `public`

### Schema design: extend before you add

A new table is the last option, not the first. Before writing `create table`, read the live
schema (`docker exec supabase_db_Corridor psql -U postgres -d postgres -c '\dt public.*'` or
`packages/db/src/schema/`) and work down this list. Stop at the first step that fits.

1. **A table with the same grain already exists** → add columns to it, nullable or with a
   default. Invitations live on `organization_members`, not an `invitations` table; the
   driver–login link is `drivers.user_id`, not a join table.
2. **The data is one-to-one with an existing table** → columns on that table, by default. A
   separate table is justified only when at least one of these holds, and the migration header
   says which:
   - a different RLS or grant surface (`organization_sso` is reached by `anon`-callable
     resolvers that must never touch `organizations`),
   - large or rarely-read columns that would bloat the hot row (embedding vectors),
   - a different lifecycle: retention, cascade, or archival.
3. **The data is a new grain** — many rows per parent, an append-only ledger, per-user rather
   than per-org — → a new table. `usage_records` (one row per billable event) and
   `user_devices` (one row per handset) are the model.
4. **Never** add a key/value bag or a `settings jsonb` column to dodge a migration.
   `organization_counters` exists for sequence counters only. `jsonb` is for provider payloads
   and free-form `metadata`, not for fields the app reads by name.

Also:

- **Denormalised copies need a trigger and a test.** `organizations.subscription_plan` mirrors
  `subscriptions.plan` through `sync_org_subscription()` and is asserted in
  `packages/db/src/jobs.integration.test.ts`. A copy kept in sync by application code is a bug
  waiting to happen.
- **Follow the existing column conventions**: `uuid primary key default gen_random_uuid()`
  (`bigint generated always as identity` for ledgers), `organization_id ... on delete cascade`,
  `created_at` / `updated_at` with the `set_updated_at()` trigger, enum-like values as `text`
  with a `check (... in (...))`, and one index per query path with a comment naming the query.
- **Every `create table` needs a "Why a new table" paragraph in the migration header**: the grain, the existing tables considered, and why each does not fit. A migration that adds a table without it is sent back in review. The per-table block in `0028_import_batches.sql` is the reference. The rule applies from `0018` onward; the 32 tables created in `0001`–`0017` predate it and are documented by their file-level banners (`0013_usage_billing.sql`, `0015_user_devices.sql`), which are not edited retroactively because applied migrations are immutable.
- **Removing or merging a table is also a new migration**, never an edit; move the data in the
  same file and drop the old table only after the Drizzle mirror and `verify:mirror` are green.

### AI Integration

- All providers via `@corridor/ai` (`packages/ai/src/client.ts`)
- Never construct `createOpenAI`/`createGateway` in call sites
- Mock mode when no API key — tests must pass without credentials
- Extraction output validated against `extractedDocument` schema before human review

### Testing

| Type        | Location                                      | Command                           |
| ----------- | --------------------------------------------- | --------------------------------- |
| Unit        | `**/*.test.ts`                                | `pnpm test`                       |
| Integration | `packages/{db,api}/src/*.integration.test.ts` | `pnpm test:integration`           |
| E2E         | `apps/web/e2e/*.spec.ts`                      | `pnpm --filter web e2e`           |
| AI Eval     | `packages/ai/src/eval/`                       | `pnpm --filter @corridor/ai eval` |
| UI          | `packages/ui/src/**/*.test.tsx`               | `pnpm --filter @corridor/ui test` |

- Integration tests require local Supabase, migrated and seeded
  (`pnpm exec supabase db reset && pnpm db:seed`)
- Playwright starts its own dev server
- Mock external services in unit tests (Upstash, Stripe, AI providers)

### Linting & Formatting

```bash
pnpm lint        # ESLint (all packages)
pnpm typecheck   # tsc --noEmit (all packages)
pnpm format      # Prettier write
pnpm format:check # Prettier check (CI)
```

Configs shared via `@corridor/config`:

- `eslint/base.js` — the single shared ESLint config
- `tsconfig/base.json` — strict TS config
- `tsconfig/library.json` — package config
- `tsconfig/nextjs.json` — web app config

## Common Tasks

### Add a New Feature

1. **Domain**: Define Zod schemas in `packages/domain/src/<feature>.ts`
2. **Database**: Work through "Schema design" above — extend an existing table where the grain
   matches. Only then create `supabase/migrations/00NN_<feature>.sql`, with the "Why a new
   table" header if it adds one
3. **Drizzle**: Mirror tables in `packages/db/src/schema/<feature>.ts`
4. **Services**: Implement logic in `packages/api/src/services/<feature>.ts`
5. **Router**: Add tRPC procedures in `packages/api/src/router/<feature>.ts`
6. **UI**: Build components in `packages/ui/` (reusable) or `apps/web/src/components/`
7. **Pages**: Add App Router pages in `apps/web/src/app/(app)/<feature>/`
8. **Tests**: Unit + integration + e2e coverage
9. **Verify**: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration`

### Update a Migration

1. Create a new migration file. **Never edit an applied migration** — a correction is a new
   file, even for a typo.
2. Update the Drizzle schema in `packages/db/src/schema/` to match, in the same change.
3. Re-apply and re-seed: `pnpm exec supabase db reset && pnpm db:seed`
4. Prove the mirror: `pnpm --filter @corridor/db verify:mirror`
5. Run `pnpm db:lint` and the integration tests
6. Update `supabase/seed.sql` if needed: `pnpm --filter @corridor/db seed:generate`

### Add an AI Capability

1. Extend `extractedDocument` in `packages/domain/src/document.ts`
2. Update extraction prompt in `packages/ai/src/document-intelligence/`
3. Add mock fixture in `packages/ai/src/eval/fixtures/`
4. Update review workspace to display new fields (read-only)
5. Run eval: `pnpm --filter @corridor/ai eval`

## Release Process

Nothing has been tagged yet; `CHANGELOG.md` tracks unreleased work. When the first release
happens:

1. Update `CHANGELOG.md` — move `[Unreleased]` into a dated version section
2. Version bump in `package.json` (root + affected packages)
3. Tag: `git tag v<version>`
4. Push the tag — Vercel deploys the web app; the Expo app is built separately

## Getting Help

`SUPPORT.md` is the index. In short:

- **Architecture questions**: Check `docs/plans/` for implementation plans
- **Type errors**: Run `pnpm typecheck` for full output
- **Test failures**: Run specific test file with `vitest run <path>`
- **Database issues**: `pnpm exec supabase status`, `pnpm exec supabase logs`
- **Security**: `docs/security-review.md` for what is already verified, `SECURITY.md` for how to
  report something

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — we follow the Contributor Covenant.
