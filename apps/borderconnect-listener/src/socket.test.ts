import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectBorderConnectSocket, type BorderConnectSocketLike } from "./socket";

/**
 * Deterministic stand-in for the `ws` package's `WebSocket`. The real
 * library is an `EventEmitter`; this reimplements just enough of that
 * surface (`on`/`send`/`ping`/`close`, synchronous `emit`) for the test to
 * drive frames and closes by hand, with fake timers controlling every delay
 * (auth timeout, ping interval, reconnect backoff) instead of real wall-clock
 * waits.
 */
class MockSocket implements BorderConnectSocketLike {
  listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  sent: string[] = [];
  pingCalls = 0;
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  closed = false;

  on(event: string, listener: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners[event] ?? []) listener(...args);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {
    this.pingCalls++;
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCalls.push({ code, reason });
    this.emit("close", code ?? 1000, reason ?? "");
  }
}

function connectedAck() {
  return { data: "API_RESPONSE", status: "OK", message: "Connected" };
}

describe("connectBorderConnectSocket", () => {
  let sockets: MockSocket[];
  let wsFactory: (url: string) => BorderConnectSocketLike;
  let urls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    urls = [];
    wsFactory = (url: string) => {
      urls.push(url);
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects to wss://borderconnect.com/api/sockets/{suffix} and sends the apiKey frame within 10s of connecting", () => {
    const onMessages = vi.fn();
    connectBorderConnectSocket({ suffix: "EasyTask", apiKey: "secret-key", onMessages, wsFactory });

    expect(urls).toEqual(["wss://borderconnect.com/api/sockets/EasyTask"]);
    const socket = sockets[0]!;
    socket.emit("open");

    expect(socket.sent).toEqual([JSON.stringify({ apiKey: "secret-key" })]);
    // Sent well inside the 10s window.
    vi.advanceTimersByTime(9_999);
    expect(socket.closed).toBe(false);
  });

  it("treats the first API_RESPONSE 'Connected' message as authentication succeeding, without forwarding it to onMessages", () => {
    const onMessages = vi.fn();
    connectBorderConnectSocket({ suffix: "EasyTask", apiKey: "secret-key", onMessages, wsFactory });
    const socket = sockets[0]!;
    socket.emit("open");

    socket.emit("message", JSON.stringify(connectedAck()));

    expect(onMessages).not.toHaveBeenCalled();
    // Auth succeeded, so the 10s auth-timeout close never fires.
    vi.advanceTimersByTime(60_000);
    expect(socket.closed).toBe(false);
  });

  it("passes every later frame to onMessages, whether delivered as a parsed object or a JSON array", () => {
    const onMessages = vi.fn();
    connectBorderConnectSocket({ suffix: "EasyTask", apiKey: "secret-key", onMessages, wsFactory });
    const socket = sockets[0]!;
    socket.emit("open");
    socket.emit("message", JSON.stringify(connectedAck()));

    const singleFrame = { data: "ACE_RESPONSE", tripStatus: "AAD" };
    socket.emit("message", singleFrame);
    expect(onMessages).toHaveBeenCalledTimes(1);
    expect(onMessages).toHaveBeenNthCalledWith(1, [singleFrame]);

    const arrayFrame = [
      { data: "RNS_SHIPMENT", cargoControlNumber: "1" },
      { data: "SYSTEM_ALERT", message: "maintenance" },
    ];
    socket.emit("message", JSON.stringify(arrayFrame));
    expect(onMessages).toHaveBeenCalledTimes(2);
    expect(onMessages).toHaveBeenNthCalledWith(2, arrayFrame);
  });

  it("fails the auth handshake cleanly (closes, does not hang) if no Connected ack arrives within 10s", () => {
    const onMessages = vi.fn();
    connectBorderConnectSocket({ suffix: "EasyTask", apiKey: "secret-key", onMessages, wsFactory });
    const socket = sockets[0]!;
    socket.emit("open");

    vi.advanceTimersByTime(9_999);
    expect(socket.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(socket.closed).toBe(true);
  });

  it("does not reconnect after ACCESS_DENIED_ERROR, even though other closes would reconnect", () => {
    const onMessages = vi.fn();
    connectBorderConnectSocket({ suffix: "EasyTask", apiKey: "secret-key", onMessages, wsFactory });
    const socket = sockets[0]!;
    socket.emit("open");

    socket.emit("message", JSON.stringify({ data: "ACCESS_DENIED_ERROR" }));
    // The listener itself should close (or the server would); either way no
    // further frame after this is ever routed to onMessages.
    expect(socket.closed).toBe(true);

    // Advance well past any possible backoff window — a real reconnect
    // attempt would call wsFactory again.
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets.length).toBe(1);
    expect(onMessages).not.toHaveBeenCalled();
  });

  it("reconnects after any other close, with capped exponential backoff starting at 1s and capping at 60s", () => {
    const onMessages = vi.fn();
    connectBorderConnectSocket({ suffix: "EasyTask", apiKey: "secret-key", onMessages, wsFactory });

    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    for (const [i, delay] of expectedDelays.entries()) {
      const socket = sockets[i]!;
      socket.emit("open");
      // A normal, non-access-denied close (e.g. the server dropped the
      // connection).
      socket.close(1006, "abnormal closure");

      expect(sockets.length).toBe(i + 1);
      vi.advanceTimersByTime(delay - 1);
      expect(sockets.length).toBe(i + 1);
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(i + 2);
    }
  });

  it("resets the backoff to 1s after a connection successfully authenticates again", () => {
    const onMessages = vi.fn();
    connectBorderConnectSocket({ suffix: "EasyTask", apiKey: "secret-key", onMessages, wsFactory });

    // First attempt fails before auth, backoff grows past 1s.
    sockets[0]!.emit("open");
    sockets[0]!.close(1006, "abnormal closure");
    vi.advanceTimersByTime(1_000);
    expect(sockets.length).toBe(2);

    sockets[1]!.emit("open");
    sockets[1]!.close(1006, "abnormal closure");
    vi.advanceTimersByTime(2_000);
    expect(sockets.length).toBe(3);

    // Third attempt authenticates successfully, then drops.
    sockets[2]!.emit("open");
    sockets[2]!.emit("message", JSON.stringify(connectedAck()));
    sockets[2]!.close(1006, "abnormal closure");

    // Next reconnect should be back at 1s, not 4s.
    vi.advanceTimersByTime(999);
    expect(sockets.length).toBe(3);
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(4);
  });

  it("sends a ping every 30s once authenticated, and stops pinging once the socket closes", () => {
    const onMessages = vi.fn();
    connectBorderConnectSocket({ suffix: "EasyTask", apiKey: "secret-key", onMessages, wsFactory });
    const socket = sockets[0]!;
    socket.emit("open");
    socket.emit("message", JSON.stringify(connectedAck()));

    expect(socket.pingCalls).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(socket.pingCalls).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(socket.pingCalls).toBe(2);

    socket.close(1006, "abnormal closure");
    vi.advanceTimersByTime(120_000);
    // No more pings from the now-closed socket.
    expect(socket.pingCalls).toBe(2);
  });

  it("never pings before authentication succeeds", () => {
    const onMessages = vi.fn();
    connectBorderConnectSocket({ suffix: "EasyTask", apiKey: "secret-key", onMessages, wsFactory });
    const socket = sockets[0]!;
    socket.emit("open");

    vi.advanceTimersByTime(9_999);
    expect(socket.pingCalls).toBe(0);
  });

  it("stop() prevents any further reconnect attempts", () => {
    const onMessages = vi.fn();
    const controller = connectBorderConnectSocket({
      suffix: "EasyTask",
      apiKey: "secret-key",
      onMessages,
      wsFactory,
    });
    const socket = sockets[0]!;
    socket.emit("open");
    socket.emit("message", JSON.stringify(connectedAck()));

    controller.stop();
    expect(socket.closed).toBe(true);

    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets.length).toBe(1);
  });

  it("stops after an inbound persistence failure so the durable spool can be replayed", async () => {
    // Proves the real failure mode this guards against: Node's default
    // `--unhandled-rejections=throw` terminates the process on an unhandled
    // rejection. If `onMessages`'s rejection here were ever left unhandled,
    // this listener would fire and the process would be one bad DB write
    // away from crashing — exactly the transient failure a socket
    // reconnect/backoff is supposed to survive, not fall over on.
    const unhandledRejections = vi.fn();
    process.on("unhandledRejection", unhandledRejections);

    try {
      const onLog = vi.fn();
      const onError = vi.fn();
      const onMessages = vi
        .fn()
        .mockRejectedValueOnce(new Error("db write failed"))
        .mockResolvedValueOnce(undefined);

      connectBorderConnectSocket({
        suffix: "EasyTask",
        apiKey: "secret-key",
        onMessages,
        wsFactory,
        onLog,
        onError,
      });
      const socket = sockets[0]!;
      socket.emit("open");
      socket.emit("message", JSON.stringify(connectedAck()));

      const firstFrame = { data: "ACE_RESPONSE", tripStatus: "AAD" };
      socket.emit("message", firstFrame);

      // Flush the microtask queue so the rejected promise's internal
      // `.catch` handler actually runs (fake timers don't affect
      // microtasks, only setTimeout/setInterval).
      await Promise.resolve();
      await Promise.resolve();

      expect(onMessages).toHaveBeenCalledTimes(1);
      expect(onMessages).toHaveBeenNthCalledWith(1, [firstFrame]);
      expect(onLog).toHaveBeenCalledWith(expect.stringContaining("durable spool must be replayed"));
      expect(onError).toHaveBeenCalledWith(expect.any(Error), {
        operation: "store_inbound",
        messageCount: 1,
      });
      expect(unhandledRejections).not.toHaveBeenCalled();

      // The listener stops after the failed batch. Accepting more frames would
      // risk overtaking the durable spool and reordering provider messages.
      const secondFrame = { data: "RNS_SHIPMENT", cargoControlNumber: "1" };
      socket.emit("message", secondFrame);
      await Promise.resolve();

      expect(onMessages).toHaveBeenCalledTimes(1);
      expect(socket.closed).toBe(true);
      expect(unhandledRejections).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejections);
    }
  });

  it("reports socket errors through the structured error hook without including frames", () => {
    const onError = vi.fn();
    connectBorderConnectSocket({
      suffix: "synthetic",
      apiKey: "secret-key",
      onMessages: vi.fn(),
      wsFactory,
      onError,
    });

    const error = new Error("connection failed");
    sockets[0]!.emit("error", error);

    expect(onError).toHaveBeenCalledWith(error, { operation: "socket" });
  });
});
