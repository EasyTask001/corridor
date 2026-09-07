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

Demo logins (password `corridor-demo`): `owner@pathfinder.demo`, `dispatch@pathfinder.demo`,
`compliance@pathfinder.demo`, `readonly@pathfinder.demo`.

## Layout

| Path                  | Purpose                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `apps/web`            | Next.js App Router UI + tRPC endpoint                                            |
| `packages/domain`     | Zod schemas, permission keys, movement state machine — shared with future mobile |
| `packages/db`         | Drizzle schema + `withRls()` transaction helper                                  |
| `packages/auth`       | Session resolution (cookie **or** Bearer), permission helpers                    |
| `packages/api`        | tRPC routers + context                                                           |
| `supabase/migrations` | SQL source of truth for schema, RLS, functions                                   |

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
width). AI output is never auto-committed: extraction is validated against `extractedDocument` and
applied only by a reviewer, and rate-confirmation data is display-only.

## Commands

- `pnpm test` — unit tests (domain, auth, api)
- `pnpm test:integration` — RLS integration tests against local Supabase
- `pnpm typecheck` / `pnpm lint` / `pnpm build`
- `pnpm --filter @corridor/db seed:generate` — regenerate `supabase/seed.sql` from domain constants
- `pnpm --filter @corridor/ai eval` — extraction regression gate over `packages/ai/src/eval/fixtures`
