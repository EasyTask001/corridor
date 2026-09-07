/**
 * Offline outbox for driver mutations.
 *
 * A driver loses signal at the border more often than not, so the mutations a
 * capture flow ends in are queued locally and replayed when the radio comes
 * back. Two rules make that safe:
 *
 *  1. Every entry is validated against the *same* `packages/domain` Zod schema
 *     the tRPC procedure uses — on the way in, so junk is never persisted, and
 *     again on the way out, so a payload written by an older build of the app
 *     can never reach the server in a shape the router would reject.
 *  2. Nothing React Native is imported here. Storage, connectivity and the
 *     transport are injected, which is what lets Vitest exercise the whole
 *     replay path without Metro.
 */
import type { z } from "zod";
import {
  finalizeUploadInput,
  notificationMarkReadInput,
  registerDeviceInput,
} from "@corridor/domain";

/**
 * The mutations a driver may queue. Deliberately small: everything here is
 * idempotent or last-write-wins, because a replay can happen twice if the app
 * is killed between the send and the removal.
 */
export const OUTBOX_OPERATIONS = {
  "documents.finalizeUpload": finalizeUploadInput,
  "notifications.markRead": notificationMarkReadInput,
  "notifications.registerDevice": registerDeviceInput,
} as const;

export type OutboxOperation = keyof typeof OUTBOX_OPERATIONS;
export type OutboxInput<K extends OutboxOperation> = z.infer<(typeof OUTBOX_OPERATIONS)[K]>;

export interface OutboxEntry {
  id: string;
  op: OutboxOperation;
  input: unknown;
  enqueuedAt: string;
  attempts: number;
  lastError?: string;
}

/** The slice of `@react-native-async-storage/async-storage` the outbox needs. */
export interface OutboxStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export type OutboxSend = (op: OutboxOperation, input: unknown) => Promise<unknown>;

export interface OutboxOptions {
  storage: OutboxStorage;
  send: OutboxSend;
  /** Latest known connectivity, from NetInfo on a device. */
  isOnline: () => boolean;
  /**
   * Who the queue currently belongs to. The queue is stored under a per-user key
   * so that on a shared handset one driver's unsent mutations can never be
   * replayed with another driver's token, and it stays *unresolved* until the
   * stored session has actually been read — see `OutboxScope`.
   */
  scope?: () => OutboxScope;
  /** Entries are discarded after this many failed replays (a poison payload must not wedge the queue). */
  maxAttempts?: number;
  now?: () => Date;
  newId?: () => string;
  onChange?: (pending: OutboxEntry[]) => void;
}

export interface FlushResult {
  sent: number;
  /** Entries dropped because they exhausted `maxAttempts` or no longer validate. */
  discarded: number;
  /** Entries still queued after the flush. */
  remaining: number;
  /** True when the flush stopped early because the transport failed. */
  interrupted: boolean;
}

const OUTBOX_KEY_PREFIX = "corridor.outbox.v1";
export const OUTBOX_MAX_ATTEMPTS = 5;

/**
 * Three distinct states, because two of them are easy to confuse and the
 * confusion is a bug:
 *
 *  - `unresolved` — the stored session has not been read yet. There is no
 *    correct key, so the queue must not be read, written or replayed at all.
 *    Anything else would silently target the wrong user's queue on launch.
 *  - `signed-out` — we know nobody is signed in. Its own key, so work queued
 *    while signed out never replays as a signed-in driver.
 *  - `user` — the signed-in driver's own queue.
 */
export type OutboxScope =
  { state: "unresolved" } | { state: "signed-out" } | { state: "user"; userId: string };

export const UNRESOLVED_SCOPE: OutboxScope = { state: "unresolved" };
export const SIGNED_OUT_SCOPE: OutboxScope = { state: "signed-out" };
export const userScope = (userId: string): OutboxScope => ({ state: "user", userId });

/** Storage key for a scope, or `null` while the session is still unknown. */
export function outboxKeyFor(scope: OutboxScope): string | null {
  if (scope.state === "unresolved") return null;
  return `${OUTBOX_KEY_PREFIX}.${scope.state === "user" ? scope.userId : "anonymous"}`;
}

/** Validate against the domain schema for `op`. Returns the parsed input or the reason it failed. */
export function validateOutboxInput<K extends OutboxOperation>(
  op: K,
  input: unknown,
): { ok: true; value: OutboxInput<K> } | { ok: false; error: string } {
  const schema = OUTBOX_OPERATIONS[op];
  if (!schema) return { ok: false, error: `Unknown outbox operation: ${String(op)}` };
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data as OutboxInput<K> }
    : {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
}

/** Thrown when something tries to queue work before we know whose queue it is. */
export class OutboxScopeError extends Error {
  constructor() {
    super("The outbox has no user scope yet — the stored session is still being read");
    this.name = "OutboxScopeError";
  }
}

export class OutboxValidationError extends Error {
  constructor(
    readonly op: string,
    message: string,
  ) {
    super(`${op}: ${message}`);
    this.name = "OutboxValidationError";
  }
}

export class Outbox {
  private readonly storage: OutboxStorage;
  private readonly send: OutboxSend;
  private readonly isOnline: () => boolean;
  private readonly scope: () => OutboxScope;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly onChange: ((pending: OutboxEntry[]) => void) | undefined;
  /** Serialises reads/writes and flushes so two callers cannot double-send. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: OutboxOptions) {
    this.storage = options.storage;
    this.send = options.send;
    this.isOnline = options.isOnline;
    this.scope = options.scope ?? (() => SIGNED_OUT_SCOPE);
    this.maxAttempts = options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.onChange = options.onChange;
  }

  /** Queue a mutation. Throws `OutboxValidationError` rather than persisting something the API would reject. */
  async enqueue<K extends OutboxOperation>(op: K, input: OutboxInput<K>): Promise<OutboxEntry> {
    // Refuse rather than write to a key we would later fail to find.
    if (!this.resolved()) throw new OutboxScopeError();
    const checked = validateOutboxInput(op, input);
    if (!checked.ok) throw new OutboxValidationError(op, checked.error);
    const entry: OutboxEntry = {
      id: this.newId(),
      op,
      input: checked.value,
      enqueuedAt: this.now().toISOString(),
      attempts: 0,
    };
    await this.serialise(async () => {
      const entries = await this.read();
      await this.write([...entries, entry]);
    });
    return entry;
  }

  /** Everything still waiting to be sent, oldest first. */
  pending(): Promise<OutboxEntry[]> {
    return this.serialise(() => this.read());
  }

  async size(): Promise<number> {
    return (await this.pending()).length;
  }

  /** Drop everything queued for the current scope. Returns how many were discarded. */
  async clear(): Promise<number> {
    return this.serialise(async () => {
      if (!this.resolved()) return 0;
      const entries = await this.read();
      await this.write([]);
      return entries.length;
    });
  }

  /**
   * Sign-out handshake: try to drain the queue first when there is a
   * connection, then clear whatever is left unconditionally — the next driver
   * on this handset must never inherit it.
   */
  async drainAndClear(): Promise<{ sent: number; discarded: number }> {
    const flushed = this.isOnline()
      ? await this.flush()
      : { sent: 0, discarded: 0, remaining: 0, interrupted: true };
    const discarded = await this.clear();
    return { sent: flushed.sent, discarded };
  }

  /**
   * Replay the queue in order. Stops at the first transport failure so later
   * mutations never overtake an earlier one, and drops entries that are either
   * invalid or have exhausted their attempts.
   */
  flush(): Promise<FlushResult> {
    return this.serialise(async () => {
      // A launch-time flush must never run before the session is known: it would
      // replay against the wrong key and leave the real queue untouched.
      if (!this.resolved()) return { sent: 0, discarded: 0, remaining: 0, interrupted: true };
      const entries = await this.read();
      if (entries.length === 0 || !this.isOnline()) {
        return { sent: 0, discarded: 0, remaining: entries.length, interrupted: !this.isOnline() };
      }

      let sent = 0;
      let discarded = 0;
      let interrupted = false;
      const remaining: OutboxEntry[] = [];

      for (const [index, entry] of entries.entries()) {
        // Re-validate: the payload may have been written by an older build.
        const checked = validateOutboxInput(entry.op, entry.input);
        if (!checked.ok) {
          discarded += 1;
          continue;
        }
        try {
          await this.send(entry.op, checked.value);
          sent += 1;
        } catch (error) {
          const attempts = entry.attempts + 1;
          if (attempts >= this.maxAttempts) {
            discarded += 1;
          } else {
            remaining.push({ ...entry, attempts, lastError: messageOf(error) });
          }
          // Keep ordering: everything after this entry waits for the next flush.
          interrupted = true;
          remaining.push(...entries.slice(index + 1));
          break;
        }
      }

      await this.write(remaining);
      return { sent, discarded, remaining: remaining.length, interrupted };
    });
  }

  /** Enqueue, then try immediately when there is a connection. */
  async submit<K extends OutboxOperation>(op: K, input: OutboxInput<K>): Promise<FlushResult> {
    await this.enqueue(op, input);
    return this.isOnline()
      ? this.flush()
      : { sent: 0, discarded: 0, remaining: await this.size(), interrupted: true };
  }

  // --- internals ----------------------------------------------------------

  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    // Swallow the rejection on the chain itself so one failure cannot poison
    // every later call, while still surfacing it to this caller.
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** True once the stored session has been read and the key is knowable. */
  private resolved(): boolean {
    return this.scope().state !== "unresolved";
  }

  /** The storage key for whoever is signed in right now, or null if unknown. */
  private key(): string | null {
    return outboxKeyFor(this.scope());
  }

  private async read(): Promise<OutboxEntry[]> {
    const key = this.key();
    if (key === null) return [];
    const raw = await this.storage.getItem(key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isEntry);
    } catch {
      // Corrupt storage is not worth crashing a driver's app over.
      return [];
    }
  }

  private async write(entries: OutboxEntry[]): Promise<void> {
    const key = this.key();
    if (key === null) return;
    await this.storage.setItem(key, JSON.stringify(entries));
    this.onChange?.(entries);
  }
}

function isEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<OutboxEntry>;
  return typeof v.id === "string" && typeof v.op === "string" && typeof v.attempts === "number";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
