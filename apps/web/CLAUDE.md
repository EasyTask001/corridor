@AGENTS.md

## AI providers (apps/web)

Every AI call — document extraction, copilot chat, copilot embeddings — resolves its provider
through `packages/ai/src/client.ts`. Never call `createOpenAI` / `createGateway` from a route
handler or a component; import `languageModel(role)` / `embeddingModel()` from `@corridor/ai`
instead, and branch the mock path on a `null` return (or `aiConfigured()`).

| Env                                             | Effect                                                        |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `AI_GATEWAY_API_KEY`                            | Vercel AI Gateway, Claude by default. Wins over OpenAI.       |
| `OPENAI_API_KEY`                                | OpenAI direct (`gpt-4.1-mini`), used only when no gateway key |
| neither                                         | deterministic local mode — mock extractor/embedder/copilot    |
| `CORRIDOR_{EXTRACTION,COPILOT,EMBEDDING}_MODEL` | override the model ID for that slot                           |

Defaults through the gateway are `anthropic/claude-sonnet-4.5` (extraction and copilot) and
`openai/text-embedding-3-small` (embeddings). The embedding model must stay 1536-dimensional —
that is the pgvector column width, and `createEmbedder` throws on any other width.

The copilot route (`src/app/api/copilot/chat/route.ts`) still runs retrieval in mock mode so
citations can be exercised without a key.

## Layout

```
apps/web/src/
├── app/
│   ├── (app)/        # authenticated shell: movements, documents, alerts, reports,
│   │                 # copilot, parties, notifications, settings/*
│   ├── (auth)/       # login / signup, plus the password sign-in server action
│   ├── auth/         # Supabase auth callback + confirm routes
│   ├── invite/[token]/, onboarding/
│   ├── api/          # trpc, copilot/chat, jobs/{process,expiry-scan},
│   │                 # realtime/token, webhooks/{stripe,supabase-auth}, health
│   ├── globals.css   # imports @corridor/ui/tokens.css
│   └── layout.tsx
├── components/       # app-specific components (app-shell, movement/, documents/, …);
│                     # anything reusable belongs in packages/ui
└── lib/              # supabase/, trpc/{client,server,query-client}, session, env,
                      # sso, cron-auth, auth-webhook, standard-webhook, jobs
```

## Patterns

- **Server Components by default.** `"use client"` only for interactivity or hooks.
- **Server Actions** for form posts that are not tRPC — `app/**/actions.ts` (`(auth)`,
  `onboarding`, `invite/[token]`, `(app)/movements`).
- **tRPC everywhere else.** In a client component: `const trpc = useTRPC()` from
  `@/lib/trpc/client`, then `useQuery(trpc.x.y.queryOptions(...))` /
  `useMutation(trpc.x.y.mutationOptions(...))`. On the server: `await api()` from
  `@/lib/trpc/server` gives a direct caller. Procedures live in `packages/api/src/router`.
- **Zod schemas live in `@corridor/domain`**, shared by the web app, the API and the Expo app.
- **RLS is the tenant boundary.** API procedures run their queries inside
  `ctx.rls(async (tx) => …)`, which opens a transaction as the `authenticated` role with the
  caller's JWT claims set. Never reach for the service-role client to read tenant data.
- **Optimistic UI** through TanStack Query `onMutate`/`onError`/`onSettled` (alerts,
  notifications).

## Environment

Variables are read from `apps/web/.env.local` (see `.env.example` at the repo root for the
full list with comments). Every third-party key is optional: with none of them set the app runs
against local Supabase with mock AI, mock Stripe, mock customs gateways, mock email and mock
push.

## Commands

```bash
pnpm dev                      # turbo dev across the workspace
pnpm --filter web build
pnpm --filter web test        # vitest
pnpm --filter web e2e         # playwright (starts its own dev server)
pnpm typecheck && pnpm lint
```
