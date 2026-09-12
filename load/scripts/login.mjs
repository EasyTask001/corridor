#!/usr/bin/env node
/**
 * Mints load-test sessions for the seeded demo users and writes them to
 * `load/.sessions.json` (git-ignored) for the k6 scripts to `open()`.
 *
 * k6 cannot log in: the sign-in flow is a Next.js Server Action and the session
 * lives in httpOnly cookies that `@supabase/ssr` writes. So this script talks to
 * Supabase Auth directly (`POST /auth/v1/token?grant_type=password`, the same
 * endpoint `signInWithPassword` uses) and emits two usable credentials per user:
 *
 *   - `accessToken` — sent by the k6 scripts as `Authorization: Bearer <jwt>`.
 *     `packages/api/src/context.ts` accepts a Bearer caller on every tRPC route
 *     (it exists for the Expo app), so this is the honest, non-brittle path.
 *   - `cookieHeader` — the same session encoded the way `@supabase/ssr` writes
 *     it (`sb-<ref>-auth-token`, `base64-` + base64url JSON, chunked at 3180
 *     URI-encoded chars). Use it when a scenario has to exercise the cookie
 *     path — Server Components, Server Actions, page loads — rather than the
 *     API. The `corridor_org` cookie carrying the active org is included too.
 *
 * Nothing here escalates anything: it is a password grant for a demo user whose
 * password is in `packages/db/scripts/seed.ts`. Never point it at production.
 *
 * Usage:
 *   pnpm load:login                       # 1 org, 1 user, local Supabase
 *   ORGS=2 DISPATCHERS_PER_ORG=3 pnpm load:login
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_ANON_KEY   default: read from repo-root .env.local
 *   BASE_URL                          default: http://localhost:3000
 *   ORGS                              default: 1   (max 2 — the seed has two)
 *   DISPATCHERS_PER_ORG               default: 1
 *   PASSWORD                          default: corridor-demo
 *   SESSIONS_FILE                     default: load/.sessions.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

/**
 * The seeded roster, in the order the scripts want it: the dispatcher first,
 * because that is the role with `movement.write` + `document.upload`, which is
 * what `bulk-upload.js` needs. See `packages/db/scripts/seed.ts`.
 */
const ROSTER = [
  {
    slug: "pathfinder",
    users: [
      "dispatch@pathfinder.demo",
      "owner@pathfinder.demo",
      "compliance@pathfinder.demo",
      "readonly@pathfinder.demo",
    ],
  },
  { slug: "northbound", users: ["owner@northbound.demo"] },
];

/** Minimal `.env.local` reader — no dependency, and only used as a default. */
function readDotEnv(path) {
  try {
    const out = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const dotenv = readDotEnv(resolve(REPO_ROOT, ".env.local"));
const SUPABASE_URL = (
  process.env.SUPABASE_URL ??
  dotenv.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:55321"
).replace(/\/$/, "");
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? dotenv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const PASSWORD = process.env.PASSWORD ?? "corridor-demo";
const ORGS = clampInt(process.env.ORGS, 1, 1, ROSTER.length);
const PER_ORG = clampInt(process.env.DISPATCHERS_PER_ORG, 1, 1, 10);
const OUT = resolve(REPO_ROOT, process.env.SESSIONS_FILE ?? "load/.sessions.json");

function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

if (!ANON_KEY) {
  fail(
    "SUPABASE_ANON_KEY is not set and .env.local has no NEXT_PUBLIC_SUPABASE_ANON_KEY.\n" +
      "Run `supabase status` and export it, or copy .env.example to .env.local.",
  );
}

/**
 * `@supabase/ssr` derives the storage key from the project ref, which it takes
 * from the first hostname label — `sb-127-auth-token` against a local
 * `http://127.0.0.1:55321`, `sb-<ref>-auth-token` against a hosted project.
 */
const STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
/** `@supabase/ssr`'s `MAX_CHUNK_SIZE` — measured on the URI-encoded value. */
const MAX_CHUNK_SIZE = 3180;

function fail(message) {
  console.error(`login.mjs: ${message}`);
  process.exit(1);
}

/** base64url of a UTF-8 string, matching `stringToBase64URL` in @supabase/ssr. */
function base64url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** The chunking @supabase/ssr applies when the encoded cookie exceeds the cap. */
function createChunks(name, value) {
  if (encodeURIComponent(value).length <= MAX_CHUNK_SIZE) return [{ name, value }];
  const chunks = [];
  let rest = value;
  while (rest.length > 0) {
    // base64url output is URI-safe, so a character is a byte here and a plain
    // slice cannot split an escape sequence.
    chunks.push({ name: `${name}.${chunks.length}`, value: rest.slice(0, MAX_CHUNK_SIZE) });
    rest = rest.slice(MAX_CHUNK_SIZE);
  }
  return chunks;
}

async function signIn(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `sign-in failed for ${email} (${res.status}): ${body.error_description ?? body.msg ?? "unknown"}. ` +
        "Has `pnpm db:seed` run against this database?",
    );
  }
  return body;
}

/**
 * The caller's own active membership. Migration 0032 removed `public` from
 * PostgREST's exposed schemas entirely (only `api`'s RPC wrappers remain, and
 * `organization_members` has none — it was never meant for direct REST
 * access), so a raw `/rest/v1/organization_members` call 404s. `organization.me`
 * is the same session-bootstrap tRPC procedure the web app itself calls, so
 * this asks the server under test rather than the database directly.
 */
async function activeOrgId(accessToken) {
  const res = await fetch(`${BASE_URL}/api/trpc/organization.me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.result?.data?.json?.activeOrganizationId ?? null;
}

const sessions = [];
const warnings = [];

for (const org of ROSTER.slice(0, ORGS)) {
  if (PER_ORG > org.users.length) {
    warnings.push(
      `${org.slug}: asked for ${PER_ORG} users, the seed only has ${org.users.length}. ` +
        "Add more seeded members if you need a wider fan-out.",
    );
  }
  for (const email of org.users.slice(0, PER_ORG)) {
    const auth = await signIn(email);
    const orgId = await activeOrgId(auth.access_token);
    if (!orgId) warnings.push(`${email}: no active membership — scripts will skip this session.`);

    // Exactly the object `@supabase/ssr` persists under the storage key.
    const stored = {
      access_token: auth.access_token,
      token_type: auth.token_type,
      expires_in: auth.expires_in,
      expires_at: auth.expires_at,
      refresh_token: auth.refresh_token,
      user: auth.user,
    };
    const cookies = createChunks(STORAGE_KEY, `base64-${base64url(JSON.stringify(stored))}`);
    if (orgId) cookies.push({ name: "corridor_org", value: orgId });

    sessions.push({
      email,
      orgSlug: org.slug,
      userId: auth.user?.id ?? null,
      orgId,
      accessToken: auth.access_token,
      refreshToken: auth.refresh_token,
      expiresAt: auth.expires_at ?? null,
      cookies,
      cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    });
    console.log(`  ✓ ${email} (org ${orgId ?? "—"})`);
  }
}

if (sessions.length === 0) fail("no sessions were minted.");

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      supabaseUrl: SUPABASE_URL,
      anonKey: ANON_KEY,
      storageKey: STORAGE_KEY,
      sessions,
    },
    null,
    2,
  )}\n`,
);

for (const w of warnings) console.warn(`  ! ${w}`);
console.log(`\nWrote ${sessions.length} session(s) to ${OUT}`);
console.log("Tokens expire in ~1h — re-run before a long test.");
