/**
 * Drizzle mirror of the SQL schema. `supabase/migrations/*.sql` is the source
 * of truth (it also carries RLS policies, triggers and functions Drizzle cannot
 * express); these files exist so application queries are typed.
 *
 * Verified column-for-column and index-for-index (key columns, order and sort
 * direction) against migrations 0001–0022 (0016 and 0017 add no columns: 0016
 * adds a policy, 0017 replaces a function). When you add a migration, mirror it
 * here in the same change and re-check with:
 *
 *   pnpm db:reset && pnpm --filter @corridor/db verify:mirror
 */
export * from "./core";
export * from "./reference";
export * from "./registry";
export * from "./alerts";
export * from "./movements";
export * from "./integrations";
export * from "./documents";
export * from "./notifications";
export * from "./copilot";
export * from "./usage";
export * from "./sso";
