/**
 * Entry point: reads env, opens the persistent BorderConnect WebSocket, and
 * writes every frame it receives straight into `customs_inbox` via the same
 * `storeInboundMessages` the HTTP drain (`customs.borderconnect_drain`)
 * uses. See `../README.md` — this app is a standalone, testable artifact;
 * it is not deployed or wired into any cron/job in this repo yet.
 *
 * Env:
 *   BORDERCONNECT_API_URL_SUFFIX  the account's assigned suffix (e.g. "EasyTask")
 *   BORDERCONNECT_API_KEY         the account's Api-Key
 *   DATABASE_URL                  service-role Postgres URL (`@corridor/db`'s
 *                                  `getDb()` reads this directly — no
 *                                  SUPABASE_* vars are needed here, since
 *                                  this app never touches supabase-js, only
 *                                  the raw Postgres connection `withServiceRole`
 *                                  runs against).
 */
import WebSocket from "ws";
import { getDb, withServiceRole } from "@corridor/db";
import { storeInboundMessages } from "@corridor/api";
import { connectBorderConnectSocket } from "./socket";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function main(): void {
  const suffix = requireEnv("BORDERCONNECT_API_URL_SUFFIX");
  const apiKey = requireEnv("BORDERCONNECT_API_KEY");
  // Throws immediately if DATABASE_URL is unset — fail fast rather than
  // accept a connection we can never persist anything from.
  const db = getDb();

  const controller = connectBorderConnectSocket({
    suffix,
    apiKey,
    // `ws`'s WebSocket already structurally satisfies BorderConnectSocketLike
    // (EventEmitter with send/ping/close) — this is the only place the real
    // `ws` package is touched, so `socket.ts` stays testable with an
    // injected fake.
    wsFactory: (url) => new WebSocket(url),
    onMessages: async (messages) => {
      if (messages.length === 0) return;
      const result = await withServiceRole(db, (tx) => storeInboundMessages(tx, messages));
      console.log(
        `[borderconnect-listener] stored=${result.stored} duplicates=${result.duplicates}`,
      );
    },
    onLog: (message) => {
      console.log(`[borderconnect-listener] ${message}`);
    },
  });

  const shutdown = (signal: string) => {
    console.log(`[borderconnect-listener] received ${signal}, shutting down`);
    controller.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
