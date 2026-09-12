import { describe, expect, it, vi } from "vitest";
import { normalisePhone, sendSms, smsMode } from "./sms";

const live = { accountSid: "ACxxx", authToken: "tok", fromNumber: "+15550001111" };

describe("smsMode", () => {
  it("is mock unless all three Twilio settings are present, and never throws", () => {
    expect(smsMode({})).toBe("mock");
    expect(smsMode({ accountSid: "AC", authToken: "t" })).toBe("mock");
    expect(smsMode(live)).toBe("twilio");
  });
});

describe("normalisePhone", () => {
  it("accepts North American and E.164 numbers, rejects junk", () => {
    expect(normalisePhone("+1 905 555 0101")).toBe("+19055550101");
    expect(normalisePhone("(905) 555-0101")).toBe("+19055550101");
    expect(normalisePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalisePhone("020 7946 0958")).toBeNull(); // bare non-NANP 10 digits: no longer silently +1
    expect(normalisePhone("020 7946 0958", "GB")).toBe("+442079460958");
    expect(normalisePhone("011 555 0101")).toBeNull(); // invalid NANP area code
    expect(normalisePhone("call me")).toBeNull();
    expect(normalisePhone("123")).toBeNull();
  });
});

describe("sendSms", () => {
  it("mock mode logs and does not call the network", async () => {
    const fetchImpl = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await sendSms({ to: "+1 905 555 0101", body: "hi" }, {}, fetchImpl as never);
    expect(r).toEqual({ mode: "mock", id: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[sms:mock] to=+19055550101"));
    log.mockRestore();
  });

  it("reports an invalid number without sending", async () => {
    const fetchImpl = vi.fn();
    const r = await sendSms({ to: "nope", body: "hi" }, live, fetchImpl as never);
    expect(r.error).toMatch(/invalid phone/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts to Twilio with basic auth and returns the SID", async () => {
    const fetchImpl = vi.fn((url: string, init: RequestInit) => {
      expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from("ACxxx:tok").toString("base64")}`,
      );
      expect(String(init.body)).toContain("To=%2B19055550101");
      expect(String(init.body)).toContain("From=%2B15550001111");
      return Promise.resolve(Response.json({ sid: "SM123" }));
    });
    const r = await sendSms(
      { to: "905-555-0101", body: "PFTR-00012: entry 30039304566 @ 3401" },
      live,
      fetchImpl as never,
    );
    expect(r).toEqual({ mode: "twilio", id: "SM123" });
  });

  it("surfaces a Twilio error instead of throwing", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ message: "unverified number" }, { status: 400 })),
    );
    const r = await sendSms({ to: "+19055550101", body: "x" }, live, fetchImpl);
    expect(r).toEqual({ mode: "twilio", id: null, error: "unverified number" });
  });
});
