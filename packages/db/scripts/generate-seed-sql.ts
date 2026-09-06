/**
 * Emits supabase/seed.sql from packages/domain constants so the permissions
 * catalogue and system-role grants have exactly one source of truth.
 *
 *   pnpm --filter @corridor/db seed:generate
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMISSIONS, SYSTEM_ROLES, SYSTEM_ROLE_PERMISSIONS } from "@corridor/domain";
import type { PermissionKey, SystemRoleKey } from "@corridor/domain";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../supabase/seed.sql");

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const lines: string[] = [
  "-- =============================================================================",
  "-- GENERATED FILE — do not edit by hand.",
  "-- Source: packages/domain/src/permission.ts + role.ts",
  "-- Regenerate: pnpm --filter @corridor/db seed:generate",
  "-- Idempotent: safe to re-run against an existing database.",
  "-- =============================================================================",
  "",
  "-- permissions catalogue",
  "insert into public.permissions (key, description, module) values",
];

const permEntries = Object.entries(PERMISSIONS) as [
  PermissionKey,
  { module: string; description: string },
][];
lines.push(
  permEntries.map(([key, v]) => `  (${q(key)}, ${q(v.description)}, ${q(v.module)})`).join(",\n"),
);
lines.push(
  "on conflict (key) do update set description = excluded.description, module = excluded.module;",
  "",
  "-- system role templates (organization_id = null)",
  "insert into public.roles (name, is_system, organization_id) values",
);
const roleEntries = Object.entries(SYSTEM_ROLES) as [SystemRoleKey, string][];
lines.push(roleEntries.map(([, name]) => `  (${q(name)}, true, null)`).join(",\n"));
lines.push("on conflict do nothing;", "");

lines.push("-- system role grants (replace-all per role so removals propagate)");
for (const [key, name] of roleEntries) {
  const grants = SYSTEM_ROLE_PERMISSIONS[key];
  lines.push(
    `delete from public.role_permissions rp using public.roles r`,
    `  where rp.role_id = r.id and r.is_system and r.name = ${q(name)};`,
    `insert into public.role_permissions (role_id, permission_id)`,
    `select r.id, p.id from public.roles r, public.permissions p`,
    `  where r.is_system and r.name = ${q(name)}`,
    `    and p.key in (${grants.map(q).join(", ")});`,
    "",
  );
}

writeFileSync(out, lines.join("\n") + "\n");
console.log(`wrote ${out} (${permEntries.length} permissions, ${roleEntries.length} roles)`);
