import { describe, expect, it, vi } from "vitest";
import { deadPushTokens, EXPO_PUSH_ENDPOINT, expoPushMode, sendExpoPush } from "./expo-push";

const message = (to: string) => ({ to, title: "Customs decision", body: "Released" });

describe("expoPushMode", () => {
  it("is mock unless EXPO_PUSH_ENABLED is exactly 'true'", () => {
    expect(expoPushMode({ enabled: false })).toBe("mock");
    expect(expoPushMode({ enabled: true })).toBe("expo");
  });
});

describe("sendExpoPush", () => {
  it("does not call the network in mock mode", async () => {
    const fetchImpl = vi.fn();
    const result = await sendExpoPush([message("ExponentPushToken[a]")], { enabled: false });
    expect(result).toMatchObject({ mode: "mock", sent: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a no-op for an empty batch", async () => {
    const fetchImpl = vi.fn();
    expect(await sendExpoPush([], { enabled: true }, fetchImpl as unknown as typeof fetch)).toEqual(
      {
        mode: "expo",
        sent: 0,
        tickets: [],
      },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the batch to Expo and counts the ok tickets", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        data: [
          { status: "ok", id: "t1" },
          { status: "error", message: "bad" },
        ],
      }),
    );
    const result = await sendExpoPush(
      [message("ExponentPushToken[a]"), message("ExponentPushToken[b]")],
      { enabled: true },
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(EXPO_PUSH_ENDPOINT);
    expect(JSON.parse(init.body as string)).toHaveLength(2);
    expect(result).toMatchObject({ mode: "expo", sent: 1 });
  });

  it("splits batches larger than 100", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: [] }));
    const many = Array.from({ length: 150 }, (_, i) => message(`ExponentPushToken[${i}]`));
    await sendExpoPush(many, { enabled: true }, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports transport failures instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const result = await sendExpoPush(
      [message("ExponentPushToken[a]")],
      { enabled: true },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.error).toBe("ECONNRESET");
    expect(result.sent).toBe(0);
  });

  it("reports an HTTP error body", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ errors: [{ message: "Invalid credentials" }] }, { status: 401 }),
    );
    const result = await sendExpoPush(
      [message("ExponentPushToken[a]")],
      { enabled: true },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.error).toBe("Invalid credentials");
  });
});

describe("deadPushTokens", () => {
  const messages = [
    message("ExponentPushToken[alive]"),
    message("ExponentPushToken[gone]"),
    message("ExponentPushToken[transient]"),
  ];

  it("picks out the tokens Expo retired, by position", () => {
    expect(
      deadPushTokens(messages, [
        { status: "ok", id: "ticket-1" },
        { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } },
        { status: "error", message: "rate limited", details: { error: "MessageRateExceeded" } },
      ]),
    ).toEqual(["ExponentPushToken[gone]"]);
  });

  it("returns nothing when there are no tickets (mock mode) or none are fatal", () => {
    expect(deadPushTokens(messages, [])).toEqual([]);
    expect(deadPushTokens(messages, [{ status: "error", message: "boom" }])).toEqual([]);
  });

  it("de-duplicates a token that failed on more than one message", () => {
    const repeated = [message("ExponentPushToken[gone]"), message("ExponentPushToken[gone]")];
    const ticket = {
      status: "error" as const,
      details: { error: "DeviceNotRegistered" },
    };
    expect(deadPushTokens(repeated, [ticket, ticket])).toEqual(["ExponentPushToken[gone]"]);
  });
});
