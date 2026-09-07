/**
 * The app's single Outbox instance: `outbox.ts` stays pure so Vitest can drive
 * it, and this module is the thin layer that binds it to AsyncStorage, NetInfo
 * and the tRPC client.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { Outbox, type OutboxEntry, type OutboxInput, type OutboxSend } from "./outbox";
import { trpc } from "./trpc";

/** Optimistic: assume a connection until NetInfo says otherwise. */
let online = true;
/** auth.users.id of the signed-in driver; set by the session provider. */
let scope: string | null = null;

export const isOnline = () => online;

const send: OutboxSend = (op, input) => {
  switch (op) {
    case "documents.finalizeUpload":
      return trpc.documents.finalizeUpload.mutate(input as OutboxInput<"documents.finalizeUpload">);
    case "notifications.markRead":
      return trpc.notifications.markRead.mutate(input as OutboxInput<"notifications.markRead">);
    case "notifications.registerDevice":
      return trpc.notifications.registerDevice.mutate(
        input as OutboxInput<"notifications.registerDevice">,
      );
  }
};

export const outbox = new Outbox({
  storage: AsyncStorage,
  send,
  isOnline,
  scope: () => scope,
});

/**
 * Point the queue at a user. Called on every auth state change so the storage
 * key follows the session — a queue written by the previous driver on a shared
 * handset is simply not visible to the next one.
 */
export function setOutboxScope(userId: string | null) {
  scope = userId;
}

/**
 * Sign-out: drain what we can, then drop the rest. Anything discarded is
 * logged with its count, because it is unsent work the driver may need to redo.
 */
export async function clearOutboxForSignOut() {
  const result = await outbox.drainAndClear();
  if (result.discarded > 0) {
    console.warn(
      `[corridor] discarded ${result.discarded} unsent mutation(s) on sign-out (${result.sent} were delivered first)`,
    );
  }
  setOutboxScope(null);
  return result;
}

/**
 * Track connectivity and replay the queue on the rising edge. Returns the
 * NetInfo unsubscribe function.
 */
export function startOutboxSync(onChange?: (state: { online: boolean; pending: number }) => void) {
  const report = async () => {
    onChange?.({ online, pending: await outbox.size() });
  };

  const unsubscribe = NetInfo.addEventListener((state) => {
    const next = state.isConnected === true && state.isInternetReachable !== false;
    const reconnected = next && !online;
    online = next;
    if (reconnected) {
      void outbox.flush().then(report);
    } else {
      void report();
    }
  });

  void outbox.flush().then(report);
  return unsubscribe;
}

export type { OutboxEntry };
