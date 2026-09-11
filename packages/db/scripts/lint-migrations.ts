import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FIRST_LINTED = 32; // 0032 pinned every earlier definer; the rule applies from there.

// Migrations are immutable once applied (see CONTRIBUTING.md) — a regression
// already caught and remediated by a later migration cannot be edited away,
// it can only be forward-fixed. 0036 briefly set search_path = public and was
// forward-fixed by 0038; grandfather this one known, already-remediated file
// so the lint still fails on any *new* regression of this kind.
const KNOWN_FIXED_FORWARD = new Set(["0036_owner_role_scope_fix.sql"]);

export function lintMigrationSource(fileName: string, source: string): string[] {
  const n = Number(fileName.slice(0, 4));
  if (!Number.isInteger(n) || n < FIRST_LINTED) return [];
  if (KNOWN_FIXED_FORWARD.has(fileName)) return [];
  const problems: string[] = [];
  // Strip SQL line comments first — "SECURITY DEFINER" shows up in prose
  // comments (e.g. 0038, 0039, 0042) and must not be mistaken for a clause.
  const withoutComments = source.replace(/--[^\n]*/g, "");
  // One block per function body: from `security definer` to the closing `$$;`.
  const blocks = withoutComments.split(/security\s+definer/i).slice(1);
  for (const block of blocks) {
    const head = block.split(/\$\$;/)[0] ?? block;
    if (/set\s+search_path\s*=\s*public\b/i.test(head)) {
      problems.push(`${fileName}: security definer function sets search_path = public; use set search_path = '' and schema-qualify every object`);
    } else if (!/set\s+search_path\s*=\s*''/i.test(head)) {
      problems.push(`${fileName}: security definer function without set search_path = ''`);
    }
  }
  return problems;
}

function main() {
  const dir = join(import.meta.dirname, "../../../supabase/migrations");
  const problems = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => lintMigrationSource(f, readFileSync(join(dir, f), "utf8")));
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("migrations: security definer search_path OK");
}

if (process.argv[1]?.endsWith("lint-migrations.ts")) main();
