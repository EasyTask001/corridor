/**
 * Entry point: reads env, opens the persistent BorderConnect WebSocket, and
 * writes every frame it receives straight into `customs_inbox` via the same
 * `storeInboundMessages` the HTTP drain (`customs.borderconnect_drain`)
 * uses. See `../README.md` — this app is a standalone, testable artifact;
 * it is not deployed or wired into any cron/job in this repo yet.
 *
 * Env:
 *   BORDERCONNECT_API_URL_SUFFIX  the account's assigned suffix
 *   BORDERCONNECT_API_KEY         the account's Api-Key
 *   DATABASE_URL                  service-role Postgres URL (`@corridor/db`'s
 *                                  `getDb()` reads this directly — no
 *                                  SUPABASE_* vars are needed here, since
 *                                  this app never touches supabase-js, only
 *                                  the raw Postgres connection `withServiceRole`
 *                                  runs against).
 */
import "./instrument";
import WebSocket from "ws";
import * as Sentry from "@sentry/node";
import { getDb, withServiceRole } from "@corridor/db";
import { storeInboundMessages } from "@corridor/api";
import { createBorderConnectSpool } from "@corridor/integrations";
import { corridorMetrics } from "@corridor/observability";
import { connectBorderConnectSocket } from "./socket";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const suffix = requireEnv("BORDERCONNECT_API_URL_SUFFIX");
  const apiKey = requireEnv("BORDERCONNECT_API_KEY");
  // Throws immediately if DATABASE_URL is unset — fail fast rather than
  // accept a connection we can never persist anything from.
  const db = getDb();
  const spool = createBorderConnectSpool();
  if (!spool) {
    throw new Error(
      "BORDERCONNECT_SPOOL_DIR and a 32-byte BORDERCONNECT_SPOOL_KEY are required for the listener",
    );
  }

  // Replay batches written before a process restart before accepting new
  // frames. Each file is removed only after the durable inbox insert commits.
  for (const batch of await spool.read()) {
    const result = await withServiceRole(db, (tx) => storeInboundMessages(tx, batch.messages));
    await spool.remove(batch.id);
    console.log(
      `[borderconnect-listener] replayed=${batch.messages.length} stored=${result.stored} duplicates=${result.duplicates}`,
    );
  }

  const controller = connectBorderConnectSocket({
    suffix,
    apiKey,
    // `ws`'s WebSocket already structurally satisfies BorderConnectSocketLike
    // (EventEmitter with send/ping/close) — this is the only place the real
    // `ws` package is touched, so `socket.ts` stays testable with an
    // injected fake.
    wsFactory: (url) => new WebSocket(url),
    onMessages: (messages) =>
      Sentry.startSpan({ name: "borderconnect.store_inbound", op: "customs.inbox" }, async () => {
        if (messages.length === 0) return;
        const batch = await spool.write(messages);
        const result = await withServiceRole(db, (tx) => storeInboundMessages(tx, messages));
        // Leave the encrypted spool file in place if the database write
        // rejects; socket.ts stops the receive loop so a restart replays it.
        if (batch) await spool.remove(batch.id);
        corridorMetrics.customsInbox({
          received: messages.length,
          stored: result.stored,
          processed: 0,
          duplicates: result.duplicates,
          unroutable: 0,
          failed: 0,
        });
        console.log(
          `[borderconnect-listener] stored=${result.stored} duplicates=${result.duplicates}`,
        );
      }),
    onError: (error, context) => {
      Sentry.captureException(error, {
        tags: { component: "borderconnect-listener", operation: context.operation },
        extra:
          context.messageCount === undefined ? undefined : { messageCount: context.messageCount },
      });
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

void main().catch((error) => {
  Sentry.captureException(error, {
    tags: { component: "borderconnect-listener", operation: "startup" },
  });
  void Sentry.flush(2_000).finally(() => process.exit(1));
});
