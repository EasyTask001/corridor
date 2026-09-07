/**
 * Realtime fan-out: many dispatcher tabs subscribed at once.
 *
 * A Corridor tab does two things on load before it can receive anything:
 *
 *   1. `GET /api/realtime/token` — the browser client has **no session of its
 *      own** (the auth cookies are httpOnly on purpose), so it asks the server
 *      for its own access token. That route is cookie-authenticated, which is
 *      why this script uses `cookieHeader` from `.sessions.json` rather than the
 *      Bearer token the other scripts use. See
 *      `apps/web/src/app/api/realtime/token/route.ts`.
 *   2. Opens one WebSocket to Supabase Realtime and joins the channels the app
 *      subscribes to — `documents` (source_documents), `notifications`
 *      (notifications) and `movement:<id>` (movements + movement_events). Without
 *      the token from step 1 the socket authenticates as `anon` and every RLS
 *      policy (`to authenticated`) silently drops the rows, so "joined" is not
 *      enough: the script asserts the `postgres_changes` subscription is
 *      acknowledged.
 *
 * This measures both: the token route under fan-out, and how many concurrent
 * authenticated subscriptions Realtime accepts. It does **not** generate the
 * writes that produce the events — run `bulk-upload.js` (or click around) in
 * parallel to see `messages_received` climb.
 *
 * Uses `k6/ws`. That module is deprecated in favour of `k6/experimental/
 * websockets` but is the one present in every k6 version from 0.20 through 1.x,
 * so it is what a script meant to be run on whatever k6 is installed should use.
 * If a future k6 drops it, the manual equivalent is:
 *
 *   wscat -c "ws://127.0.0.1:55321/realtime/v1/websocket?apikey=$ANON&vsn=1.0.0"
 *   > {"topic":"realtime:documents","event":"phx_join","payload":{"config":{
 *      "postgres_changes":[{"event":"*","schema":"public","table":
 *      "source_documents"}]},"access_token":"<jwt>"},"ref":"1","join_ref":"1"}
 *   # expect phx_reply status ok, then a `system` frame:
 *   # {"status":"ok","extension":"postgres_changes","message":"Subscribed to PostgreSQL"}
 *
 * Run:
 *   pnpm load:login
 *   k6 run load/k6/realtime-fanout.js
 *   ORGS=2 DISPATCHERS_PER_ORG=4 TABS=200 HOLD_S=120 k6 run load/k6/realtime-fanout.js
 *
 * Env: BASE_URL, ORGS, DISPATCHERS_PER_ORG, TABS, HOLD_S, RAMP.
 */
import { check, sleep } from "k6";
import http from "k6/http";
import ws from "k6/ws";
import { Counter, Rate, Trend } from "k6/metrics";
import { baseUrl, cookieHeaders, intEnv, loadSessions, selectSessions } from "./lib.js";

const file = loadSessions();
const BASE = baseUrl(file);
const SESSIONS = selectSessions(
  file.sessions,
  intEnv("ORGS", 1),
  intEnv("DISPATCHERS_PER_ORG", 1),
);

const TABS = intEnv("TABS", 50);
const HOLD_S = intEnv("HOLD_S", 60);
const RAMP = __ENV.RAMP ?? "30s";
const REALTIME_URL = `${file.supabaseUrl.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${file.anonKey}&vsn=1.0.0`;

/** The channels `documents-panel.tsx` and `notification-bell.tsx` subscribe to. */
const CHANNELS = [
  { topic: "realtime:documents", table: "source_documents", event: "*" },
  { topic: "realtime:notifications", table: "notifications", event: "INSERT" },
];

const tokenDuration = new Trend("realtime_token_duration", true);
const socketOpen = new Rate("socket_opened");
const subscribed = new Rate("channel_subscribed");
const messages = new Counter("messages_received");
const socketErrors = new Counter("socket_errors");

export const options = {
  scenarios: {
    tabs: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: RAMP, target: TABS },
        { duration: `${HOLD_S}s`, target: TABS },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: `${HOLD_S}s`,
    },
  },
  thresholds: {
    // The token route is on the critical path of every page load.
    realtime_token_duration: ["p(95)<500"],
    socket_opened: ["rate==1"],
    // Every join must be acknowledged *and* confirmed against Postgres —
    // an anon socket joins happily and then receives nothing.
    channel_subscribed: ["rate==1"],
    checks: ["rate>0.99"],
  },
};

export default function realtimeFanout() {
  const session = SESSIONS[(__VU - 1) % SESSIONS.length];

  // 1. What the tab does first: ask the server for its own access token.
  const tokenRes = http.get(`${BASE}/api/realtime/token`, {
    headers: cookieHeaders(session),
    tags: { route: "realtime-token" },
  });
  tokenDuration.add(tokenRes.timings.duration);
  const token = tokenRes.status === 200 ? JSON.parse(tokenRes.body).token : null;
  if (
    !check(tokenRes, {
      "realtime token 200": (r) => r.status === 200,
      "realtime token has a jwt": () => typeof token === "string" && token.length > 0,
    })
  ) {
    return;
  }

  // 2. One socket per tab, joining every channel the app joins.
  let acked = 0;
  const res = ws.connect(REALTIME_URL, { tags: { route: "realtime-ws" } }, (socket) => {
    let ref = 0;

    socket.on("open", () => {
      socketOpen.add(true);
      for (const ch of CHANNELS) {
        ref += 1;
        socket.send(
          JSON.stringify({
            topic: ch.topic,
            event: "phx_join",
            payload: {
              config: {
                broadcast: { ack: false, self: false },
                presence: { key: "" },
                postgres_changes: [{ event: ch.event, schema: "public", table: ch.table }],
              },
              access_token: token,
            },
            ref: String(ref),
            join_ref: String(ref),
          }),
        );
      }
      // Realtime closes an idle socket after ~60s without one.
      socket.setInterval(() => {
        ref += 1;
        socket.send(
          JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(ref) }),
        );
      }, 25000);
    });

    socket.on("message", (raw) => {
      messages.add(1);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.event === "phx_reply" && msg.payload?.status !== "ok") {
        socketErrors.add(1);
        subscribed.add(false);
        return;
      }
      // The frame that proves the subscription is authenticated: Realtime only
      // reports "Subscribed to PostgreSQL" once the WAL listener is attached
      // for this socket's claims.
      if (
        msg.event === "system" &&
        msg.payload?.extension === "postgres_changes" &&
        msg.payload?.status === "ok"
      ) {
        acked += 1;
        subscribed.add(true);
      }
    });

    socket.on("error", () => socketErrors.add(1));
    socket.setTimeout(() => socket.close(), HOLD_S * 1000);
  });

  if (res.status !== 101) socketOpen.add(false);
  check(res, { "websocket upgraded (101)": (r) => r.status === 101 });
  check(null, { "every channel subscribed": () => acked === CHANNELS.length });

  sleep(1);
}
