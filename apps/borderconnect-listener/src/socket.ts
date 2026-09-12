/**
 * A persistent `wss://borderconnect.com/api/sockets/{suffix}` connection
 * writing every frame it receives into the same `customs_inbox` table the
 * HTTP drain (`packages/api/src/services/borderconnect.ts`) already reads
 * from. This module is transport-only: it never interprets a message, only
 * hands the raw frame(s) to `onMessages` (see `index.ts` for the wiring to
 * `storeInboundMessages`).
 *
 * Protocol, as documented for this task (not yet confirmed against a live
 * account — see the package README):
 *   - The first frame this side sends, within 10s of connecting, is
 *     `{"apiKey": "..."}`.
 *   - The server's first reply is an `API_RESPONSE`
 *     `{"data":"API_RESPONSE","status":"OK","message":"Connected",...}`,
 *     which counts as authentication succeeding. It is never forwarded to
 *     `onMessages` — every later frame is.
 *   - `ACCESS_DENIED_ERROR` means the key is bad/expired: the socket must
 *     close and never reconnect (reconnecting would hammer a dead key).
 *   - Any other close reconnects, with capped exponential backoff (1s,
 *     doubling, capped at 60s; reset to 1s the next time a connection
 *     authenticates).
 *   - A ping is sent every 30s once authenticated, to keep the connection
 *     alive; no ping is sent before authentication.
 */

/**
 * The minimal `ws`-shaped surface this module needs. The real `ws` package's
 * `WebSocket` satisfies this (it is an `EventEmitter` with `send`/`ping`/
 * `close`); tests inject a deterministic fake instead.
 */
export interface BorderConnectSocketLike {
  // A single, non-overloaded signature (mirroring `EventEmitter`'s own base
  // signature) rather than one specific per event: it keeps this interface
  // trivially satisfiable both by a cast of `ws`'s real `WebSocket` (whose
  // per-event listener types are narrower than this) and by a plain test
  // double, without fighting TypeScript's overload-vs-implementation
  // compatibility rules over event-specific argument types this module never
  // actually needs (every handler below ignores its arguments except
  // `"message"`'s).
  on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): void;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
}

export type BorderConnectWsFactory = (url: string) => BorderConnectSocketLike;

export interface ConnectBorderConnectSocketOptions {
  /** The account's assigned suffix, e.g. "EasyTask" (`BORDERCONNECT_API_URL_SUFFIX`). */
  suffix: string;
  apiKey: string;
  /** Called with every post-auth frame, normalised to an array of messages. */
  onMessages: (messages: Record<string, unknown>[]) => void | Promise<void>;
  /** `ws`'s `WebSocket` constructor in production; a deterministic fake in tests. */
  wsFactory: BorderConnectWsFactory;
  /** Defaults to `wss://borderconnect.com`. */
  baseUrl?: string;
  /** Defaults to 10s. */
  authTimeoutMs?: number;
  /** Defaults to 30s. */
  pingIntervalMs?: number;
  /** Defaults to 1s. */
  initialBackoffMs?: number;
  /** Defaults to 60s. */
  maxBackoffMs?: number;
  /** Optional diagnostics hook — never throws, never required. */
  onLog?: (message: string) => void;
}

export interface BorderConnectSocketController {
  /** Stops the listener for good: closes the current socket, cancels any pending reconnect. */
  stop: () => void;
}

function parseFrame(data: unknown): unknown {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  if (data instanceof Uint8Array) {
    const text = Buffer.from(data).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  // Already a parsed object/array (what a test's mock factory delivers).
  return data;
}

function toMessageArray(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === "object") return [parsed as Record<string, unknown>];
  return [];
}

function asRecord(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** The auth-ack frame: `{"data":"API_RESPONSE","status":"OK","message":"Connected",...}`. */
function isConnectedAck(parsed: unknown): boolean {
  const obj = asRecord(parsed);
  if (!obj) return false;
  return obj.data === "API_RESPONSE" && (obj.status === "OK" || obj.message === "Connected");
}

/** A bad/expired key. Seen as a distinct frame from the "API_RESPONSE" ack. */
function isAccessDenied(parsed: unknown): boolean {
  const obj = asRecord(parsed);
  if (!obj) return false;
  return (
    obj.data === "ACCESS_DENIED_ERROR" ||
    obj.status === "ACCESS_DENIED_ERROR" ||
    obj.errorCode === "ACCESS_DENIED_ERROR"
  );
}

export function connectBorderConnectSocket(
  opts: ConnectBorderConnectSocketOptions,
): BorderConnectSocketController {
  const {
    suffix,
    apiKey,
    onMessages,
    wsFactory,
    baseUrl = "wss://borderconnect.com",
    authTimeoutMs = 10_000,
    pingIntervalMs = 30_000,
    initialBackoffMs = 1_000,
    maxBackoffMs = 60_000,
    onLog,
  } = opts;
  const url = `${baseUrl}/api/sockets/${suffix}`;

  let stopped = false;
  let accessDenied = false;
  let backoff = initialBackoffMs;
  let currentSocket: BorderConnectSocketLike | null = null;
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const log = (message: string) => onLog?.(message);

  function clearAuthTimer(): void {
    if (authTimer) {
      clearTimeout(authTimer);
      authTimer = null;
    }
  }

  function clearPingTimer(): void {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (stopped || accessDenied) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxBackoffMs);
    log(`reconnecting in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (stopped) return;
    let authenticated = false;
    const socket = wsFactory(url);
    currentSocket = socket;

    // The auth handshake must fail cleanly (close, not hang forever) if the
    // server never answers.
    authTimer = setTimeout(() => {
      authTimer = null;
      log("auth timed out waiting for API_RESPONSE Connected; closing");
      try {
        socket.close();
      } catch {
        // ignore — the close handler below still runs the reconnect logic.
      }
    }, authTimeoutMs);

    socket.on("open", () => {
      try {
        socket.send(JSON.stringify({ apiKey }));
      } catch {
        // A send failure here will surface as an error/close shortly after.
      }
    });

    socket.on("message", (data: unknown) => {
      const parsed = parseFrame(data);

      if (isAccessDenied(parsed)) {
        accessDenied = true;
        log("ACCESS_DENIED_ERROR — closing, will not reconnect");
        try {
          socket.close();
        } catch {
          // ignore
        }
        return;
      }

      if (!authenticated) {
        if (isConnectedAck(parsed)) {
          authenticated = true;
          clearAuthTimer();
          backoff = initialBackoffMs;
          pingTimer = setInterval(() => {
            try {
              socket.ping();
            } catch {
              // A dead socket's ping failure will show up as a close shortly.
            }
          }, pingIntervalMs);
        }
        // Pre-auth frames (the ack itself, or anything else before it) are
        // never forwarded to onMessages.
        return;
      }

      const messages = toMessageArray(parsed);
      if (messages.length > 0) void onMessages(messages);
    });

    socket.on("close", () => {
      clearAuthTimer();
      clearPingTimer();
      currentSocket = null;
      if (stopped || accessDenied) return;
      scheduleReconnect();
    });

    socket.on("error", (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`socket error: ${message}`);
      // The close handler (always fired by a real WebSocket after an error)
      // owns the reconnect decision — nothing to do here beyond logging.
    });
  }

  connect();

  return {
    stop(): void {
      stopped = true;
      clearAuthTimer();
      clearPingTimer();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (currentSocket) {
        try {
          currentSocket.close();
        } catch {
          // ignore
        }
        currentSocket = null;
      }
    },
  };
}
