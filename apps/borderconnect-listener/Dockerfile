# NOT deployed anywhere yet — see README.md. This Dockerfile exists so the
# app is a genuinely runnable, testable artifact for a future decision about
# hosting it, not just a folder of TypeScript files.
#
# This repo ships every package as TypeScript source, run through a
# TS-aware runtime (tsx, Next.js, Vitest) rather than a compiled `dist/` —
# no package here has a bundler step, and `@corridor/api`/`@corridor/db`
# have no built output for a plain `node` process to import. This image
# follows the same convention: `pnpm deploy` materializes a real
# node_modules for this package's workspace dependencies (resolving the
# `workspace:*` protocol into copies pnpm can install without the rest of
# the monorepo present), and the app still runs via `tsx` at container
# runtime — `tsx` is a devDependency here specifically so it survives into
# the deployed folder alongside the app's own devDependencies.
#
# `--legacy` is required: pnpm v10's default `deploy` needs
# `inject-workspace-packages=true` in `.npmrc` (this repo has none, and
# adding one repo-wide is out of scope for an undeployed app); `--legacy`
# is pnpm's own documented fallback and was verified locally to produce a
# working, runnable deploy folder (`pnpm --filter @corridor/borderconnect-listener
# deploy --legacy <dir>`, then `node_modules/.bin/tsx src/index.ts` from
# inside it — confirmed to actually reach BorderConnect's real socket
# endpoint and parse its response).
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.32.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @corridor/borderconnect-listener deploy --legacy /deploy/listener

FROM node:22-alpine
WORKDIR /app
COPY --from=build /deploy/listener .
ENV NODE_ENV=production
CMD ["node_modules/.bin/tsx", "src/index.ts"]
