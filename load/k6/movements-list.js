/**
 * Movement list under dispatcher load.
 *
 * The dispatcher board is the screen the whole product is used from, and its
 * two queries (`movement.list`, `movement.board`) are the ones that fan out
 * over joins and a `count(*)`. This is the scenario that decides whether the
 * indexes from 0003/0011 are doing their job.
 *
 * Threshold: **p95 < 500ms** for `movement.list` (the plan's number). It is
 * measured on a dedicated Trend rather than on `http_req_duration`, so the
 * board query and the warm-up cannot flatter or spoil it.
 *
 * Run:
 *   pnpm load:login
 *   k6 run load/k6/movements-list.js
 *   ORGS=2 DISPATCHERS_PER_ORG=4 VUS=40 DURATION=3m k6 run load/k6/movements-list.js
 *
 * Env: BASE_URL, ORGS, DISPATCHERS_PER_ORG, VUS, DURATION, RAMP.
 */
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";
import {
  baseUrl,
  intEnv,
  loadSessions,
  selectSessions,
  trpcData,
  trpcQuery,
} from "./lib.js";

const file = loadSessions();
const BASE = baseUrl(file);
const SESSIONS = selectSessions(
  file.sessions,
  intEnv("ORGS", 1),
  intEnv("DISPATCHERS_PER_ORG", 1),
);

const VUS = intEnv("VUS", 20);
const DURATION = __ENV.DURATION ?? "2m";
const RAMP = __ENV.RAMP ?? "20s";

const listDuration = new Trend("movement_list_duration", true);
const boardDuration = new Trend("movement_board_duration", true);
const rateLimited = new Rate("rate_limited");

export const options = {
  scenarios: {
    dispatchers: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: DURATION, target: VUS },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    // The plan's bar.
    movement_list_duration: ["p(95)<500"],
    movement_board_duration: ["p(95)<500"],
    checks: ["rate>0.99"],
    // A 429 means the run outgrew the plan's rate limit, not that the query is
    // slow — see the README on CORRIDOR_RATELIMIT_MULTIPLIER.
    rate_limited: ["rate<0.01"],
  },
};

/** A spread of the filters the board actually sends, so plans vary as they do in use. */
const FILTERS = [
  {},
  { status: ["draft"] },
  { status: ["sent", "accepted"] },
  { regime: "ACE" },
  { regime: "ACI" },
  { search: "ACE-" },
];

export default function movementsList() {
  const session = SESSIONS[(__VU - 1) % SESSIONS.length];
  const filter = FILTERS[__ITER % FILTERS.length];

  const list = trpcQuery(BASE, session, "movement.list", { ...filter, limit: 50, offset: 0 });
  listDuration.add(list.timings.duration);
  rateLimited.add(list.status === 429);
  const listed = trpcData(list);
  check(list, {
    "movement.list 200": (r) => r.status === 200,
    "movement.list returns rows + total": () => listed !== null && Array.isArray(listed.rows),
  });

  const board = trpcQuery(BASE, session, "movement.board", undefined);
  boardDuration.add(board.timings.duration);
  rateLimited.add(board.status === 429);
  check(board, { "movement.board 200": (r) => r.status === 200 });

  // A dispatcher reads the board between refreshes; back-to-back requests would
  // measure the rate limiter rather than the query.
  sleep(1);
}
