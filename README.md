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

## Commands

- `pnpm test` — unit tests (domain, auth, api)
- `pnpm test:integration` — RLS integration tests against local Supabase
- `pnpm typecheck` / `pnpm lint` / `pnpm build`
- `pnpm --filter @corridor/db seed:generate` — regenerate `supabase/seed.sql` from domain constants
