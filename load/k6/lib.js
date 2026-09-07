/**
 * Shared init-context helpers for the k6 scripts in this directory.
 *
 * Everything here runs in k6's init context (or is pure), so it can be imported
 * by any of the scenario scripts without side effects per iteration.
 */
import http from "k6/http";

/**
 * The sessions minted by `load/scripts/login.mjs`. `open()` is init-only and
 * resolves relative to *this* file, so every script gets the same path.
 */
export function loadSessions() {
  let raw;
  try {
    raw = open("../.sessions.json");
  } catch {
    throw new Error(
      "load/.sessions.json is missing. Run `pnpm load:login` first " +
        "(ORGS / DISPATCHERS_PER_ORG select how many sessions it mints).",
    );
  }
  const parsed = JSON.parse(raw);
  const usable = parsed.sessions.filter((s) => s.orgId);
  if (usable.length === 0) {
    throw new Error("load/.sessions.json has no session with an active organization.");
  }
  return { ...parsed, sessions: usable };
}

/** Trim the roster to ORGS × DISPATCHERS_PER_ORG, honouring what actually exists. */
export function selectSessions(all, orgs, perOrg) {
  const bySlug = new Map();
  for (const s of all) {
    if (!bySlug.has(s.orgSlug)) bySlug.set(s.orgSlug, []);
    bySlug.get(s.orgSlug).push(s);
  }
  const picked = [];
  for (const [, list] of [...bySlug].slice(0, orgs)) picked.push(...list.slice(0, perOrg));
  return picked.length > 0 ? picked : all;
}

export function intEnv(name, fallback) {
  const n = Number(__ENV[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function baseUrl(sessions) {
  return (__ENV.BASE_URL ?? sessions.baseUrl ?? "http://localhost:3000").replace(/\/$/, "");
}

/**
 * Headers for a tRPC call. The API accepts `Authorization: Bearer` on every
 * route (`packages/api/src/context.ts` — it exists for the Expo client), which
 * is what lets k6 skip the cookie session entirely. `x-corridor-org` is the
 * active-org hint the web app sends as the `corridor_org` cookie.
 */
export function apiHeaders(session) {
  return {
    authorization: `Bearer ${session.accessToken}`,
    "x-corridor-org": session.orgId,
    "content-type": "application/json",
  };
}

/** Cookie headers, for the routes that read the httpOnly session (page loads, /api/realtime/token). */
export function cookieHeaders(session) {
  return { cookie: session.cookieHeader };
}

/** `GET /api/trpc/<path>?input=…` — superjson-wrapped, matching the web client. */
export function trpcQuery(base, session, path, input) {
  const query =
    input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  return http.get(`${base}/api/trpc/${path}${query}`, {
    headers: apiHeaders(session),
    tags: { trpc: path },
  });
}

/** `POST /api/trpc/<path>` — superjson-wrapped, matching the web client. */
export function trpcMutation(base, session, path, input) {
  return http.post(`${base}/api/trpc/${path}`, JSON.stringify({ json: input }), {
    headers: apiHeaders(session),
    tags: { trpc: path },
  });
}

/** The `data.json` payload of a tRPC response, or null when the call failed. */
export function trpcData(res) {
  if (res.status !== 200) return null;
  try {
    const body = JSON.parse(res.body);
    return body.error ? null : (body.result?.data?.json ?? null);
  } catch {
    return null;
  }
}
