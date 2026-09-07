/**
 * Loads packages/db/data/ports/*.csv into public.ports.
 *
 *   pnpm --filter @corridor/db ports:import
 *
 * Each file shares one header: regime,kind,code,name,state_province,country,parent_code.
 * The parser is a hand-rolled split on "," — none of this data contains a
 * quoted comma, so a CSV library would only add a dependency for nothing.
 * Lines starting with "#" (the file's `# source:` provenance comment) are
 * skipped. Upserts on (regime, kind, code), so re-running after editing a CSV
 * is safe and idempotent.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, "../data/ports");

const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

const FILES = [
  "us_ports.csv",
  "cbsa_offices.csv",
  "in_bond_destinations.csv",
  "firms.csv",
  "cbsa_sublocations.csv",
] as const;

interface PortRow {
  regime: string;
  kind: string;
  code: string;
  name: string;
  stateProvince: string | null;
  country: string;
  parentCode: string | null;
}

function parseCsv(text: string): PortRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0 && !line.startsWith("#"));
  const [header, ...rows] = lines;
  if (!header) return [];
  const columns = header.split(",").map((c) => c.trim());
  return rows.map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const byCol = Object.fromEntries(columns.map((col, i) => [col, cells[i] ?? ""]));
    return {
      regime: byCol.regime!,
      kind: byCol.kind!,
      code: byCol.code!,
      name: byCol.name!,
      stateProvince: byCol.state_province || null,
      country: byCol.country!,
      parentCode: byCol.parent_code || null,
    };
  });
}

export async function importPorts() {
  const sql = postgres(DB_URL, { max: 1 });
  try {
    let total = 0;
    for (const file of FILES) {
      const text = readFileSync(resolve(DATA_DIR, file), "utf8");
      const rows = parseCsv(text);
      for (const row of rows) {
        await sql`
          insert into public.ports (regime, kind, code, name, state_province, country, parent_code, active)
          values (${row.regime}, ${row.kind}, ${row.code}, ${row.name}, ${row.stateProvince},
                  ${row.country}, ${row.parentCode}, true)
          on conflict (regime, kind, code) do update set
            name = excluded.name,
            state_province = excluded.state_province,
            country = excluded.country,
            parent_code = excluded.parent_code,
            active = true`;
      }
      total += rows.length;
      console.log(`ports: imported ${rows.length} row(s) from ${file}`);
    }
    console.log(`ports: ${total} row(s) total`);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  importPorts().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
