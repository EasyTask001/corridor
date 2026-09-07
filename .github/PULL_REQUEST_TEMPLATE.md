## What changed

<!-- One or two sentences. The diff shows what; explain why. -->

Closes #

## Type of change

- [ ] `feat` — new functionality
- [ ] `fix` — bug fix
- [ ] `chore` / `refactor` / `docs` — no behaviour change

## Testing

<!-- Delete the lines that do not apply. -->

- [ ] `pnpm typecheck && pnpm lint && pnpm test`
- [ ] `pnpm test:integration` (touched SQL, RLS, or the API)
- [ ] `pnpm --filter web e2e` (touched a user flow)
- [ ] Manual check — describe what you did:

## Schema changes

<!-- Delete this section if `supabase/migrations/` is untouched. -->

- [ ] New migration file only — no applied migration was edited
- [ ] No new table, **or** the migration header has a "Why a new table" paragraph naming the
      existing tables considered and why each does not fit (`CONTRIBUTING.md` → Schema design)
- [ ] Any denormalised copy is trigger-maintained and covered by an integration test
- [ ] Drizzle schema in `packages/db/src/schema/` updated in the same change
- [ ] `pnpm db:lint` passes
- [ ] `pnpm --filter @corridor/db verify:mirror` passes
- [ ] RLS enabled and policies written for any new table
- [ ] Cross-tenant integration test added for any new table

## Security checklist

See `SECURITY.md` → "Checklist for contributors".

- [ ] No secret in code, log line or comment
- [ ] New mutations classified in `AUDITED_MUTATIONS` or `AUDIT_EXEMPT_MUTATIONS`
- [ ] Any new `SECURITY DEFINER` function callable by `authenticated` re-checks the caller
- [ ] Feature still works with the external service's env var unset (mock mode)

## Screenshots

<!-- UI changes only. Before / after, or a short recording. -->
