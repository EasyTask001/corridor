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

export const OUTBOX_STORAGE_KEY = "corridor.outbox.v1";
export const OUTBOX_MAX_ATTEMPTS = 5;

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
    this.maxAttempts = options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.onChange = options.onChange;
  }

  /** Queue a mutation. Throws `OutboxValidationError` rather than persisting something the API would reject. */
  async enqueue<K extends OutboxOperation>(op: K, input: OutboxInput<K>): Promise<OutboxEntry> {
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

  async clear(): Promise<void> {
    await this.serialise(() => this.write([]));
  }

  /**
   * Replay the queue in order. Stops at the first transport failure so later
   * mutations never overtake an earlier one, and drops entries that are either
   * invalid or have exhausted their attempts.
   */
  flush(): Promise<FlushResult> {
    return this.serialise(async () => {
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

  private async read(): Promise<OutboxEntry[]> {
    const raw = await this.storage.getItem(OUTBOX_STORAGE_KEY);
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
    await this.storage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(entries));
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
