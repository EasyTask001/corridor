# Corridor

AI-native cross-border customs compliance SaaS for carriers (ACE / ACI e-manifests).
Multi-tenant, Postgres RLS as the tenant boundary, Next.js on Vercel, Supabase backend.

## Quick start

```bash
pnpm install
pnpm db:start                 # local Supabase (Docker) — applies migrations + seed.sql
supabase status -o env        # copy ANON_KEY / SERVICE_ROLE_KEY into apps/web/.env.local
pnpm db:seed                  # demo carrier + users (see packages/db/scripts/seed.ts)
pnpm dev                      # http://localhost:3000
```

The local stack uses the 553xx port range, not Supabase's defaults (`supabase/config.toml`):
API `55321`, Postgres `55322`, Studio `55323`, Inbucket (mail) `55324`.

Demo logins (password `corridor-demo`): `owner@pathfinder.demo`, `dispatch@pathfinder.demo`,
`compliance@pathfinder.demo`, `readonly@pathfinder.demo`, `driver@pathfinder.demo`, plus
`owner@northbound.demo` — a second tenant, there so cross-tenant isolation is visible by hand.

No third-party key is required to run anything. With no `AI_GATEWAY_API_KEY`/`OPENAI_API_KEY`,
`STRIPE_SECRET_KEY`, `RESEND_API_KEY`, `UPSTASH_*` or `EXPO_PUSH_ENABLED`, every one of those
services degrades to a deterministic local mock.

## Layout

| Path                    | Purpose                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `apps/web`              | Next.js App Router UI + tRPC endpoint                                            |
| `apps/mobile`           | Expo driver app — same tRPC router over a Bearer token (`apps/mobile/README.md`) |
| `packages/domain`       | Zod schemas, permission keys, movement state machine — shared with mobile        |
| `packages/db`           | Drizzle schema + `withRls()` / `withServiceRole()` transaction helpers           |
| `packages/auth`         | Session resolution (cookie **or** Bearer), permission helpers                    |
| `packages/api`          | tRPC routers, context and services                                               |
| `packages/ai`           | Provider resolver + extraction, copilot, reporting and predictive pipelines      |
| `packages/integrations` | Stripe, customs gateways, SSO, tariff, email and Expo push clients               |
| `packages/ui`           | shadcn-style component library + design tokens (`@corridor/ui`)                  |
| `supabase/migrations`   | SQL source of truth for schema, RLS, functions                                   |

## Principles

- **RLS is the tenant boundary.** Tenant data is read and written inside `ctx.rls(...)`, which
  runs as `authenticated` with the caller's claims. `withServiceRole()` exists for the few
  actorless paths and must filter `organization_id` itself.
- **No secrets reach the browser.** Session cookies are `httpOnly`; provider credentials live in
  Supabase Vault and are readable only by the service role.
- **AI output is never auto-committed.** Extraction is validated against a schema and applied by
  a reviewer; suggestions and rate data are advisory.
- **Migrations are the source of truth.** New SQL goes in `supabase/migrations/00NN_*.sql`;
  the Drizzle schema mirrors it and `pnpm --filter @corridor/db verify:mirror` proves it.

## AI providers

AI calls go through one resolver, `packages/ai/src/client.ts` — call sites never construct a
provider themselves.

- `AI_GATEWAY_API_KEY` → Vercel AI Gateway, Claude (`anthropic/claude-sonnet-4.5`) for extraction
  and copilot, `openai/text-embedding-3-small` for embeddings. Takes precedence over OpenAI.
- `OPENAI_API_KEY` → OpenAI direct (`gpt-4.1-mini`, `text-embedding-3-small`), used only when no
  gateway key is set.
- Neither → deterministic local mode: mock extractor, mock embedder, mock copilot. No key is
  needed to run the app, the tests or the extraction eval.

Model IDs are overridable per slot with `CORRIDOR_EXTRACTION_MODEL`, `CORRIDOR_COPILOT_MODEL` and
`CORRIDOR_EMBEDDING_MODEL`. The embedding model must be 1536-dimensional (the pgvector column
width).

## Commands

| Command                                       | What it does                                                    |
| --------------------------------------------- | --------------------------------------------------------------- |
| `pnpm dev`                                    | Turbo dev across the workspace                                  |
| `pnpm build` / `pnpm typecheck` / `pnpm lint` | Build, type-check, lint every package                           |
| `pnpm test`                                   | Unit tests (domain, auth, api, ai, ui, web, mobile)             |
| `pnpm test:integration`                       | RLS + queue integration tests against local Supabase            |
| `pnpm format` / `pnpm format:check`           | Prettier over `ts,tsx,md,json,yml`                              |
| `pnpm db:start` / `pnpm db:stop`              | Local Supabase stack                                            |
| `pnpm db:reset` / `pnpm db:seed`              | Re-apply migrations + `seed.sql`, then the demo data script     |
| `pnpm db:types`                               | Regenerate `packages/db/src/supabase-types.ts` (git-ignored)    |
| `pnpm db:lint` / `pnpm db:advisors`           | `supabase db lint` (fails on warnings) / local DB stats         |
| `pnpm --filter @corridor/db verify:mirror`    | Prove the Drizzle schema still matches the live database        |
| `pnpm --filter @corridor/db seed:generate`    | Regenerate `supabase/seed.sql` from domain constants            |
| `pnpm --filter @corridor/ai eval`             | Extraction regression gate over `packages/ai/src/eval/fixtures` |
| `pnpm --filter web e2e`                       | Playwright end-to-end suite (starts its own dev server)         |
| `pnpm --filter @corridor/mobile start`        | Expo dev server for the driver app                              |

## Security

`docs/security-review.md` is the standing review: RLS coverage, service-role inventory, the
SECURITY DEFINER audit, rate limiting, webhook signature verification, and the open findings.
`SECURITY.md` is how to report something.

## Contributing

See `CONTRIBUTING.md`. In short: branch, conventional commit, and `pnpm typecheck && pnpm lint
&& pnpm test` (plus `pnpm test:integration` when you touch SQL or the API) before you push.

## License

Proprietary — all rights reserved.
