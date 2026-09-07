/**
 * Expo push delivery for the driver app, with a mock mode identical in spirit
 * to the Resend wrapper: unless EXPO_PUSH_ENABLED is "true" the sends are
 * logged rather than dispatched, so notification fan-out is fully exercised in
 * dev/CI without an Expo project or real handsets.
 *
 * Deliberately no `expo-server-sdk` dependency — the send endpoint is one
 * `fetch` and the SDK would drag Expo's toolchain into the server bundle.
 */

export type ExpoPushMode = "expo" | "mock";

/** https://docs.expo.dev/push-notifications/sending-notifications/ */
export const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

/** Expo accepts at most 100 messages per request. */
export const EXPO_PUSH_BATCH_SIZE = 100;

export interface ExpoPushEnv {
  enabled: boolean;
  /** Optional; only required for projects with "Enhanced Security for Push Notifications" on. */
  accessToken?: string;
}

export function readExpoPushEnv(env: NodeJS.ProcessEnv = process.env): ExpoPushEnv {
  return {
    enabled: env.EXPO_PUSH_ENABLED === "true",
    accessToken: env.EXPO_ACCESS_TOKEN,
  };
}

export function expoPushMode(env: ExpoPushEnv = readExpoPushEnv()): ExpoPushMode {
  return env.enabled ? "expo" : "mock";
}

export interface ExpoPushMessage {
  /** `ExponentPushToken[...]` — validated upstream by `expoPushToken` in @corridor/domain. */
  to: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

export interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  /**
   * Expo's machine-readable reason. `DeviceNotRegistered` means the token is
   * permanently dead (app uninstalled, or the receipt expired) and Expo asks
   * senders to stop using it — see `deadPushTokens`.
   */
  details?: { error?: string };
}

/**
 * Which of `messages` Expo has told us to stop sending to. Tickets come back
 * positionally aligned with the messages that produced them, so a short or
 * absent ticket array (mock mode, or a transport error part-way through) simply
 * yields fewer entries.
 */
export function deadPushTokens(
  messages: readonly ExpoPushMessage[],
  tickets: readonly ExpoPushTicket[],
): string[] {
  const dead = new Set<string>();
  tickets.forEach((ticket, i) => {
    const to = messages[i]?.to;
    if (to && ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
      dead.add(to);
    }
  });
  return [...dead];
}

export interface SendExpoPushResult {
  mode: ExpoPushMode;
  sent: number;
  tickets: ExpoPushTicket[];
  error?: string;
}

/**
 * Send a batch of push messages. Never throws: a push failure must not roll
 * back the transaction that created the in-app notification, so transport
 * errors come back on `error` for the integration_events row.
 */
export async function sendExpoPush(
  messages: ExpoPushMessage[],
  env: ExpoPushEnv = readExpoPushEnv(),
  fetchImpl: typeof fetch = fetch,
): Promise<SendExpoPushResult> {
  if (messages.length === 0) return { mode: expoPushMode(env), sent: 0, tickets: [] };
  if (expoPushMode(env) === "mock") {
    console.log(`[expo-push:mock] recipients=${messages.length} title="${messages[0]!.title}"`);
    return { mode: "mock", sent: messages.length, tickets: [] };
  }

  const tickets: ExpoPushTicket[] = [];
  for (let i = 0; i < messages.length; i += EXPO_PUSH_BATCH_SIZE) {
    const batch = messages.slice(i, i + EXPO_PUSH_BATCH_SIZE);
    try {
      const res = await fetchImpl(EXPO_PUSH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(env.accessToken ? { Authorization: `Bearer ${env.accessToken}` } : {}),
        },
        body: JSON.stringify(batch),
      });
      const body = (await res.json().catch(() => ({}))) as {
        data?: ExpoPushTicket[];
        errors?: { message?: string }[];
      };
      if (!res.ok) {
        return {
          mode: "expo",
          sent: tickets.filter((t) => t.status === "ok").length,
          tickets,
          error: body.errors?.[0]?.message ?? `HTTP ${res.status}`,
        };
      }
      tickets.push(...(body.data ?? []));
    } catch (e) {
      return {
        mode: "expo",
        sent: tickets.filter((t) => t.status === "ok").length,
        tickets,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return { mode: "expo", sent: tickets.filter((t) => t.status === "ok").length, tickets };
}
