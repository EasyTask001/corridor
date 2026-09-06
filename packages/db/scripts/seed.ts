/**
 * Idempotent dev seed: applies supabase/seed.sql (permissions + system roles)
 * then creates a demo organization with a few users via the Supabase admin API.
 *
 *   pnpm db:seed
 *
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DIRECT_DATABASE_URL
 * (all provided by `supabase start` locally).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { SYSTEM_ROLES } from "@corridor/domain";

const here = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

if (!SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required (see `supabase status`)");
  process.exit(1);
}

export const DEMO_ORG = {
  name: "Pathfinder Trans Inc",
  legalName: "PATHFINDER TRANS INC",
  scacCode: "PFTR",
  canadianCarrierCode: "PFT1",
  usDotNumber: "1234567",
  mcNumber: "MC-987654",
} as const;

export const DEMO_USERS = [
  {
    email: "owner@pathfinder.demo",
    password: "corridor-demo",
    role: SYSTEM_ROLES.owner,
    name: "Harjit Owner",
  },
  {
    email: "dispatch@pathfinder.demo",
    password: "corridor-demo",
    role: SYSTEM_ROLES.dispatcher,
    name: "Dana Dispatcher",
  },
  {
    email: "compliance@pathfinder.demo",
    password: "corridor-demo",
    role: SYSTEM_ROLES.compliance_officer,
    name: "Chris Compliance",
  },
  {
    email: "readonly@pathfinder.demo",
    password: "corridor-demo",
    role: SYSTEM_ROLES.read_only,
    name: "Riley Readonly",
  },
] as const;

/** A second, unrelated org used by cross-tenant-leak tests. */
export const OTHER_ORG = { name: "Northbound Freight Ltd", scacCode: "NBFL" } as const;
export const OTHER_USER = {
  email: "owner@northbound.demo",
  password: "corridor-demo",
  role: SYSTEM_ROLES.owner,
  name: "Nora Northbound",
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = SupabaseClient<any, any, any, any, any>;

async function ensureUser(
  admin: AdminClient,
  u: { email: string; password: string; name: string },
) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const existing = list?.users.find((x) => x.email === u.email);
  if (existing) return existing.id;
  const { data, error } = await admin.auth.admin.createUser({
    email: u.email,
    password: u.password,
    email_confirm: true,
    user_metadata: { display_name: u.name },
  });
  if (error) throw error;
  return data.user.id;
}

export async function seed() {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const sql = postgres(DB_URL, { max: 1 });

  try {
    // 1. catalogue + system roles
    const seedSql = readFileSync(resolve(here, "../../../supabase/seed.sql"), "utf8");
    await sql.unsafe(seedSql);

    // 2. demo org + users
    const roles = await sql<{ id: string; name: string }[]>`
      select id, name from public.roles where is_system`;
    const roleId = (name: string) => {
      const r = roles.find((x) => x.name === name);
      if (!r) throw new Error(`system role ${name} missing`);
      return r.id;
    };

    async function ensureOrg(org: { name: string; [k: string]: string }) {
      const [row] = await sql<{ id: string }[]>`
        insert into public.organizations (name, legal_name, scac_code, canadian_carrier_code, us_dot_number, mc_number)
        values (${org.name}, ${org.legalName ?? null}, ${org.scacCode ?? null},
                ${org.canadianCarrierCode ?? null}, ${org.usDotNumber ?? null}, ${org.mcNumber ?? null})
        on conflict do nothing
        returning id`;
      if (row) return row.id;
      const [existing] = await sql<{ id: string }[]>`
        select id from public.organizations where name = ${org.name} limit 1`;
      return existing!.id;
    }

    const orgId = await ensureOrg(DEMO_ORG);
    for (const u of DEMO_USERS) {
      const userId = await ensureUser(admin, u);
      await sql`
        insert into public.organization_members (organization_id, user_id, role_id, status)
        values (${orgId}, ${userId}, ${roleId(u.role)}, 'active')
        on conflict (organization_id, user_id) where user_id is not null
        do update set role_id = excluded.role_id, status = 'active'`;
    }

    const otherOrgId = await ensureOrg(OTHER_ORG);
    const otherUserId = await ensureUser(admin, OTHER_USER);
    await sql`
      insert into public.organization_members (organization_id, user_id, role_id, status)
      values (${otherOrgId}, ${otherUserId}, ${roleId(OTHER_USER.role)}, 'active')
      on conflict (organization_id, user_id) where user_id is not null
      do update set role_id = excluded.role_id, status = 'active'`;

    console.log(`seeded org ${DEMO_ORG.name} (${orgId}) with ${DEMO_USERS.length} users`);
    console.log(`seeded org ${OTHER_ORG.name} (${otherOrgId}) with 1 user`);
    return { orgId, otherOrgId };
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  seed().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
