import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Outbox,
  OutboxScopeError,
  OutboxValidationError,
  SIGNED_OUT_SCOPE,
  UNRESOLVED_SCOPE,
  outboxKeyFor,
  userScope,
  validateOutboxInput,
  type OutboxEntry,
  type OutboxScope,
  type OutboxStorage,
} from "./outbox";

const ANON_KEY = outboxKeyFor(SIGNED_OUT_SCOPE)!;
const keyFor = (userId: string) => outboxKeyFor(userScope(userId))!;

/** In-memory stand-in for AsyncStorage. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const storage: OutboxStorage & {
    snapshot: (userId?: string | null) => OutboxEntry[];
    keys: () => string[];
  } = {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => void map.set(key, value),
    snapshot: (userId = null) =>
      JSON.parse(map.get(userId === null ? ANON_KEY : keyFor(userId)) ?? "[]") as OutboxEntry[],
    keys: () => [...map.keys()],
  };
  return storage;
}

const DOC = "11111111-1111-4111-8111-111111111111";
const NOTE = "22222222-2222-4222-8222-222222222222";

let ids = 0;
function build(
  overrides: Partial<ConstructorParameters<typeof Outbox>[0]> & {
    storage?: ReturnType<typeof memoryStorage>;
  } = {},
) {
  const storage = overrides.storage ?? memoryStorage();
  const send = overrides.send ?? vi.fn(async () => ({ ok: true }));
  const online = { value: overrides.isOnline ? overrides.isOnline() : true };
  const outbox = new Outbox({
    storage,
    send,
    isOnline: overrides.isOnline ?? (() => online.value),
    ...(overrides.scope ? { scope: overrides.scope } : {}),
    maxAttempts: overrides.maxAttempts ?? 3,
    now: () => new Date("2026-09-07T00:00:00.000Z"),
    newId: () => `id-${(ids += 1)}`,
    ...(overrides.onChange ? { onChange: overrides.onChange } : {}),
  });
  return { outbox, storage, send: send as ReturnType<typeof vi.fn>, online };
}

beforeEach(() => {
  ids = 0;
});

describe("validateOutboxInput", () => {
  it("accepts an input the tRPC procedure would accept", () => {
    expect(validateOutboxInput("documents.finalizeUpload", { documentId: DOC })).toEqual({
      ok: true,
      value: { documentId: DOC },
    });
  });

  it("rejects one the procedure would reject, with the field name", () => {
    const result = validateOutboxInput("documents.finalizeUpload", { documentId: "not-a-uuid" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("documentId");
  });

  it("enforces the Expo token shape from the domain schema", () => {
    expect(
      validateOutboxInput("notifications.registerDevice", {
        expoPushToken: "just-a-string",
        platform: "ios",
      }).ok,
    ).toBe(false);
    expect(
      validateOutboxInput("notifications.registerDevice", {
        expoPushToken: "ExponentPushToken[abc123]",
        platform: "ios",
      }).ok,
    ).toBe(true);
  });
});

describe("Outbox.enqueue", () => {
  it("persists a valid mutation", async () => {
    const { outbox, storage } = build();
    const entry = await outbox.enqueue("notifications.markRead", { id: NOTE });
    expect(entry).toMatchObject({ op: "notifications.markRead", attempts: 0 });
    expect(storage.snapshot()).toHaveLength(1);
  });

  it("refuses — and stores nothing — when the input fails the domain schema", async () => {
    const { outbox, storage } = build();
    await expect(
      // A caller can only get here by bypassing the types, which is exactly
      // the case the guard exists for.
      outbox.enqueue("notifications.markRead", { id: "nope" } as never),
    ).rejects.toBeInstanceOf(OutboxValidationError);
    expect(storage.snapshot()).toEqual([]);
  });
});

describe("Outbox.flush", () => {
  it("sends nothing while offline and keeps the queue intact", async () => {
    const { outbox, send, online } = build();
    online.value = false;
    await outbox.enqueue("notifications.markRead", { id: NOTE });
    const result = await outbox.flush();
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, remaining: 1, interrupted: true });
  });

  it("replays queued mutations in order once back online", async () => {
    const { outbox, send, online, storage } = build();
    online.value = false;
    await outbox.enqueue("documents.finalizeUpload", { documentId: DOC });
    await outbox.enqueue("notifications.markRead", { id: NOTE });

    online.value = true;
    const result = await outbox.flush();

    expect(send.mock.calls.map((c) => c[0])).toEqual([
      "documents.finalizeUpload",
      "notifications.markRead",
    ]);
    expect(result).toMatchObject({ sent: 2, discarded: 0, remaining: 0, interrupted: false });
    expect(storage.snapshot()).toEqual([]);
  });

  it("stops at the first transport failure so ordering is preserved", async () => {
    const send = vi.fn(async (op: string) => {
      if (op === "documents.finalizeUpload") throw new Error("offline");
      return {};
    });
    const { outbox, storage } = build({ send });
    await outbox.enqueue("documents.finalizeUpload", { documentId: DOC });
    await outbox.enqueue("notifications.markRead", { id: NOTE });

    const result = await outbox.flush();
    expect(result).toMatchObject({ sent: 0, remaining: 2, interrupted: true });
    const queued = storage.snapshot();
    expect(queued.map((e) => e.op)).toEqual(["documents.finalizeUpload", "notifications.markRead"]);
    expect(queued[0]).toMatchObject({ attempts: 1, lastError: "offline" });
  });

  it("discards a poison entry after maxAttempts instead of wedging the queue", async () => {
    const send = vi.fn(async () => {
      throw new Error("500");
    });
    const { outbox, storage } = build({ send, maxAttempts: 3 });
    await outbox.enqueue("notifications.markRead", { id: NOTE });

    await outbox.flush();
    await outbox.flush();
    expect(storage.snapshot()[0]).toMatchObject({ attempts: 2 });

    const last = await outbox.flush();
    expect(last).toMatchObject({ discarded: 1, remaining: 0 });
    expect(storage.snapshot()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("drops a persisted payload that no longer validates and never sends it", async () => {
    // Written by an older build: `documentId` was a plain string back then.
    const storage = memoryStorage({
      [ANON_KEY]: JSON.stringify([
        {
          id: "stale",
          op: "documents.finalizeUpload",
          input: { documentId: "legacy-id" },
          enqueuedAt: "2026-01-01T00:00:00.000Z",
          attempts: 0,
        },
        {
          id: "fresh",
          op: "notifications.markRead",
          input: { id: NOTE },
          enqueuedAt: "2026-01-01T00:00:00.000Z",
          attempts: 0,
        },
      ]),
    });
    const { outbox, send } = build({ storage });

    const result = await outbox.flush();
    expect(result).toMatchObject({ sent: 1, discarded: 1, remaining: 0 });
    expect(send.mock.calls.map((c) => c[0])).toEqual(["notifications.markRead"]);
  });

  it("survives corrupt storage", async () => {
    const storage = memoryStorage({ [ANON_KEY]: "{not json" });
    const { outbox } = build({ storage });
    expect(await outbox.pending()).toEqual([]);
  });

  it("serialises overlapping flushes so nothing is sent twice", async () => {
    let resolveSend: (() => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const { outbox } = build({ send });
    await outbox.enqueue("notifications.markRead", { id: NOTE });

    const first = outbox.flush();
    const second = outbox.flush();
    // The second flush must find an empty queue, not a second copy of the entry.
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    resolveSend?.();
    const [a, b] = await Promise.all([first, second]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(a.sent + b.sent).toBe(1);
  });
});

describe("Outbox.submit", () => {
  it("sends straight through when online", async () => {
    const { outbox, send, storage } = build();
    const result = await outbox.submit("notifications.markRead", { id: NOTE });
    expect(result).toMatchObject({ sent: 1, remaining: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(storage.snapshot()).toEqual([]);
  });

  it("just queues when offline", async () => {
    const { outbox, send, online, storage } = build();
    online.value = false;
    const result = await outbox.submit("notifications.markRead", { id: NOTE });
    expect(send).not.toHaveBeenCalled();
    expect(result.remaining).toBe(1);
    expect(storage.snapshot()).toHaveLength(1);
  });
});

describe("per-user scoping", () => {
  const DRIVER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const DRIVER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("writes each user's queue under its own key", async () => {
    const storage = memoryStorage();
    let user = DRIVER_A;
    const { outbox, online } = build({ storage, scope: () => userScope(user) });
    online.value = false;

    await outbox.enqueue("notifications.markRead", { id: NOTE });
    user = DRIVER_B;
    await outbox.enqueue("documents.finalizeUpload", { documentId: DOC });

    expect(storage.snapshot(DRIVER_A).map((e) => e.op)).toEqual(["notifications.markRead"]);
    expect(storage.snapshot(DRIVER_B).map((e) => e.op)).toEqual(["documents.finalizeUpload"]);
    expect(storage.keys().sort()).toEqual([keyFor(DRIVER_A), keyFor(DRIVER_B)].sort());
  });

  it("never replays one driver's queue for the next driver on the handset", async () => {
    const storage = memoryStorage();
    let user = DRIVER_A;
    const { outbox, send, online } = build({ storage, scope: () => userScope(user) });
    online.value = false;
    await outbox.enqueue("notifications.markRead", { id: NOTE });

    // Driver A signs out without a connection, Driver B signs in.
    user = DRIVER_B;
    online.value = true;
    const result = await outbox.flush();

    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, remaining: 0 });
    // A's work is still on disk under A's key, untouched.
    expect(storage.snapshot(DRIVER_A)).toHaveLength(1);
  });

  it("clear() empties only the current scope and reports the count", async () => {
    const storage = memoryStorage();
    let user = DRIVER_A;
    const { outbox, online } = build({ storage, scope: () => userScope(user) });
    online.value = false;
    await outbox.enqueue("notifications.markRead", { id: NOTE });
    user = DRIVER_B;
    await outbox.enqueue("documents.finalizeUpload", { documentId: DOC });

    expect(await outbox.clear()).toBe(1);
    expect(storage.snapshot(DRIVER_B)).toEqual([]);
    expect(storage.snapshot(DRIVER_A)).toHaveLength(1);
  });
});

describe("Outbox.drainAndClear", () => {
  it("delivers what it can, then empties the queue", async () => {
    const { outbox, send, storage } = build();
    await outbox.enqueue("notifications.markRead", { id: NOTE });
    const result = await outbox.drainAndClear();
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 1, discarded: 0 });
    expect(storage.snapshot()).toEqual([]);
  });

  it("still empties the queue when offline, reporting what was thrown away", async () => {
    const { outbox, send, online, storage } = build();
    online.value = false;
    await outbox.enqueue("notifications.markRead", { id: NOTE });
    await outbox.enqueue("documents.finalizeUpload", { documentId: DOC });

    const result = await outbox.drainAndClear();
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, discarded: 2 });
    expect(storage.snapshot()).toEqual([]);
  });

  it("empties the queue even when the transport is failing", async () => {
    const send = vi.fn(async () => {
      throw new Error("502");
    });
    const { outbox, storage } = build({ send });
    await outbox.enqueue("notifications.markRead", { id: NOTE });
    const result = await outbox.drainAndClear();
    expect(result).toEqual({ sent: 0, discarded: 1 });
    expect(storage.snapshot()).toEqual([]);
  });
});

describe("unresolved scope (app launch)", () => {
  const DRIVER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  /**
   * The bug this guards: `startOutboxSync` used to flush the moment the app
   * started, before `getSession()` had resolved, so the launch replay ran
   * against the wrong key and the driver's real queue sat unsent until a
   * NetInfo offline→online edge that might never come.
   */
  it("replays the signed-in driver's queue on launch, not the anonymous one", async () => {
    const storage = memoryStorage({
      [keyFor(DRIVER)]: JSON.stringify([
        {
          id: "queued-before-launch",
          op: "notifications.markRead",
          input: { id: NOTE },
          enqueuedAt: "2026-01-01T00:00:00.000Z",
          attempts: 0,
        },
      ]),
    });
    // The fake session flow: unresolved at launch, then resolved to the driver.
    let scope: OutboxScope = UNRESOLVED_SCOPE;
    const { outbox, send } = build({ storage, scope: () => scope });

    // Whatever fires before the session is read must do nothing at all.
    expect(await outbox.flush()).toMatchObject({ sent: 0, remaining: 0, interrupted: true });
    expect(await outbox.pending()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(storage.snapshot(DRIVER)).toHaveLength(1);

    // getSession() resolves → the very next flush finds the driver's own queue.
    scope = userScope(DRIVER);
    expect(await outbox.flush()).toMatchObject({ sent: 1, remaining: 0 });
    expect(send.mock.calls.map((c) => c[0])).toEqual(["notifications.markRead"]);
    expect(storage.snapshot(DRIVER)).toEqual([]);
  });

  it("refuses to queue anything before the session is known", async () => {
    const storage = memoryStorage();
    const { outbox } = build({ storage, scope: () => UNRESOLVED_SCOPE });
    await expect(outbox.enqueue("notifications.markRead", { id: NOTE })).rejects.toBeInstanceOf(
      OutboxScopeError,
    );
    expect(storage.keys()).toEqual([]);
  });

  it("clear() is a no-op while unresolved, so nothing is destroyed on launch", async () => {
    const storage = memoryStorage({
      [keyFor(DRIVER)]: JSON.stringify([
        {
          id: "keep-me",
          op: "notifications.markRead",
          input: { id: NOTE },
          enqueuedAt: "2026-01-01T00:00:00.000Z",
          attempts: 0,
        },
      ]),
    });
    const { outbox } = build({ storage, scope: () => UNRESOLVED_SCOPE });
    expect(await outbox.clear()).toBe(0);
    expect(storage.snapshot(DRIVER)).toHaveLength(1);
  });

  it("gives signed-out work its own key, distinct from unresolved", () => {
    expect(outboxKeyFor(UNRESOLVED_SCOPE)).toBeNull();
    expect(outboxKeyFor(SIGNED_OUT_SCOPE)).toBe(ANON_KEY);
    expect(outboxKeyFor(userScope(DRIVER))).not.toBe(ANON_KEY);
  });
});
