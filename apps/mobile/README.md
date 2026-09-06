# apps/mobile — placeholder

Expo / React Native driver app, built in **Phase 10**.

Architected-in from day 0:

- imports `@corridor/domain` for every schema/type (no parallel contract);
- calls the same `/api/trpc` endpoint via `@trpc/client` `httpBatchLink` with an
  `Authorization: Bearer <supabase jwt>` header — `packages/api/src/context.ts`
  already resolves Bearer sessions;
- session stored in `expo-secure-store`; Driver-Portal system role is already seeded.
