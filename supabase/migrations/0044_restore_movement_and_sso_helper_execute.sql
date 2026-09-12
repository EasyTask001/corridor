-- 0032's blanket `revoke execute on all functions in schema public from
-- public, anon, authenticated` (line 53) removed EXECUTE from every function
-- in the schema. 0037 restored it for 7 named RLS-predicate helpers, but
-- missed ten more functions that a caller legitimately needs to invoke
-- directly or indirectly. Found via a systematic audit for issue #3
-- (github.com/EasyTask001/corridor), cross-checked against every row of
-- docs/security-review.md's own §9b table of functions granted to a
-- non-owner role.
--
-- Group 1 — plain (non-SECURITY-DEFINER) functions called BY NAME from
-- inside another function/constraint running as `authenticated`:
--
--   - movement_can_transition(text, text) / movement_is_editable(text)
--     (0003) — called from movements_guard(), shipments_guard(), and every
--     other movement/shipment/equipment/crew/manifest trigger guard added in
--     0008, 0011, 0018, 0019, 0020, 0021, 0022. None of those trigger
--     functions are SECURITY DEFINER, so they run as the invoking role, and
--     the nested call to these two helpers is privilege-checked against that
--     role — unlike the trigger functions themselves, which fire regardless
--     of EXECUTE on the trigger function (Postgres invokes triggers via the
--     trigger event, not a direct call). Net effect: an authenticated user's
--     INSERT/UPDATE on movements, shipments, equipment, crew, or manifest/
--     customs-event tables fails with "permission denied for function
--     movement_can_transition" (or movement_is_editable).
--
--   - sso_domains_valid(text[]) (0014) — evaluated by the
--     organization_sso_domains_shape CHECK constraint on organization_sso.
--     Unlike a trigger, a CHECK constraint's function calls ARE
--     privilege-checked against the writing role. authenticated already
--     holds table-level INSERT/UPDATE on organization_sso (gated further by
--     RLS/has_permission), so this blocked SSO domain configuration the same
--     way.
--
-- Group 2 — SECURITY DEFINER functions docs/security-review.md's §9b audit
-- already documents as "Reachable by: authenticated" (each re-checks the
-- caller internally — has_permission/auth.uid()/a token match — so the
-- missing grant was purely an oversight, not a deliberate restriction).
-- Calling a SECURITY DEFINER function still requires EXECUTE on the function
-- itself before its body (and its owner's privileges) ever run — SECURITY
-- DEFINER only changes what happens *inside*, not whether a given role may
-- invoke it in the first place:
--
--   - accept_invitation(text) (0001) — invite-acceptance flow.
--   - create_organization_with_owner(...) (0001) — signup/onboarding.
--   - current_user_permissions(uuid) (0002-era) — permission lookups.
--   - store_integration_secret(uuid, text, text) / delete_integration_secret(uuid, text)
--     (0012) — customs gateway credential management
--     (integrations.manage-gated internally).
--
-- Group 3 — the same class as Group 2, but §9b documents these as
-- "Reachable by: anon (by design)" rather than authenticated: the login
-- page has no session yet, so the SSO discovery lookup has to run
-- unauthenticated. `api.sso_provider_for_email`/`api.sso_enforced_for_email`
-- (0032) — the PostgREST-facing wrappers — were correctly left
-- anon-executable throughout, but the `public.*` functions they wrap lost
-- their own direct anon grant in the same 0032 sweep and were never
-- restored:
--
--   - sso_provider_for_email(citext) / sso_enforced_for_email(citext) (0001)

-- Group 1
grant execute on function public.movement_can_transition(text, text) to authenticated;
grant execute on function public.movement_is_editable(text) to authenticated;
grant execute on function public.sso_domains_valid(text[]) to authenticated;

-- Group 2
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.create_organization_with_owner(text, text, text, text, text, text) to authenticated;
grant execute on function public.current_user_permissions(uuid) to authenticated;
grant execute on function public.store_integration_secret(uuid, text, text) to authenticated;
grant execute on function public.delete_integration_secret(uuid, text) to authenticated;

-- Group 3
grant execute on function public.sso_provider_for_email(citext) to anon;
grant execute on function public.sso_enforced_for_email(citext) to anon;

-- All three groups are covered going forward by the systematic invariant
-- tests in packages/db/src/security-invariants.integration.test.ts.
