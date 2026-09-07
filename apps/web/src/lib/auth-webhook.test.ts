import { describe, expect, it } from "vitest";
import {
  WEBHOOK_SECRET_HEADER,
  authorizeAuthWebhook,
  displayNameFor,
  parseAuthWebhook,
} from "./auth-webhook";
import { signStandardWebhook } from "./standard-webhook";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const USER_ID = "6d1c8a2e-1c3a-4b6f-9a5e-2f7d0b3c4e51";

/** The shape a Database Webhook on `auth.users` actually POSTs. */
function payload(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "INSERT",
    table: "users",
    schema: "auth",
    record: {
      id: USER_ID,
      email: "newuser@pathfinder.demo",
      raw_user_meta_data: { display_name: "New User" },
      encrypted_password: "should-be-ignored",
    },
    old_record: null,
    ...over,
  });
}

function headers(over: Record<string, string | null> = {}) {
  const h = new Headers();
  const base: Record<string, string> = { [WEBHOOK_SECRET_HEADER]: SECRET };
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) h.set(k, v);
  return h;
}

describe("parseAuthWebhook", () => {
  it("accepts an INSERT and returns the new row", () => {
    const result = parseAuthWebhook(payload());
    expect(result).toMatchObject({ ok: true, payload: { type: "INSERT" } });
    if (result.ok) expect(result.record.id).toBe(USER_ID);
  });

  it("takes the row from old_record on DELETE", () => {
    const raw = payload({
      type: "DELETE",
      record: null,
      old_record: { id: USER_ID, email: "gone@pathfinder.demo" },
    });
    const result = parseAuthWebhook(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.id).toBe(USER_ID);
  });

  it.each([
    ["public", "users"],
    ["auth", "sessions"],
  ])("rejects a trigger on %s.%s", (schema, table) => {
    expect(parseAuthWebhook(payload({ schema, table }))).toMatchObject({
      ok: false,
      reason: `unexpected source ${schema}.${table}`,
    });
  });

  it("rejects an event with no row", () => {
    expect(parseAuthWebhook(payload({ record: null }))).toMatchObject({
      ok: false,
      reason: "INSERT carried no row",
    });
  });

  it("rejects an Auth Hook payload (which has no type/table/schema)", () => {
    const authHookShape = JSON.stringify({ metadata: {}, user: { id: USER_ID } });
    expect(parseAuthWebhook(authHookShape)).toMatchObject({
      ok: false,
      reason: "not a Database Webhook payload",
    });
  });

  it("rejects a non-JSON body", () => {
    expect(parseAuthWebhook("<html>nope</html>")).toMatchObject({
      ok: false,
      reason: "body is not valid JSON",
    });
  });
});

describe("displayNameFor", () => {
  it("prefers raw_user_meta_data.display_name, like the 0001 trigger", () => {
    expect(
      displayNameFor({
        id: USER_ID,
        email: "a@b.com",
        raw_user_meta_data: { display_name: "Dana" },
      }),
    ).toBe("Dana");
  });

  it("falls back to the local part of the email", () => {
    expect(displayNameFor({ id: USER_ID, email: "dispatch@pathfinder.demo" })).toBe("dispatch");
    expect(
      displayNameFor({ id: USER_ID, email: "x@y.com", raw_user_meta_data: { display_name: "  " } }),
    ).toBe("x");
  });

  it("is null when there is nothing to go on", () => {
    expect(displayNameFor({ id: USER_ID })).toBeNull();
    expect(displayNameFor({ id: USER_ID, email: null })).toBeNull();
  });
});

describe("authorizeAuthWebhook", () => {
  const authorize = (over: { headers?: Headers; body?: string; now?: number } = {}) =>
    authorizeAuthWebhook({
      secret: SECRET,
      body: over.body ?? payload(),
      headers: over.headers ?? headers(),
      ...(over.now !== undefined && { now: over.now }),
    });

  it("accepts the shared-secret header", () => {
    expect(authorize()).toEqual({ ok: true });
  });

  it("rejects a missing header", () => {
    expect(authorize({ headers: headers({ [WEBHOOK_SECRET_HEADER]: null }) })).toMatchObject({
      ok: false,
      reason: `missing ${WEBHOOK_SECRET_HEADER}`,
    });
  });

  it("rejects a wrong secret, and one that is merely a prefix", () => {
    expect(authorize({ headers: headers({ [WEBHOOK_SECRET_HEADER]: "nope" }) })).toMatchObject({
      ok: false,
      reason: "shared secret mismatch",
    });
    expect(
      authorize({ headers: headers({ [WEBHOOK_SECRET_HEADER]: SECRET.slice(0, -1) }) }),
    ).toMatchObject({ ok: false, reason: "shared secret mismatch" });
  });

  it("also verifies Standard Webhooks headers when the sender signs", () => {
    const body = payload();
    const id = "msg_dbwebhook";
    const timestamp = 1700000000;
    const h = headers({
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signStandardWebhook({ secret: SECRET, body, id, timestamp }),
    });
    expect(authorize({ headers: h, body, now: timestamp * 1000 })).toEqual({ ok: true });
  });

  it("rejects a bad signature even when the shared secret is right", () => {
    const h = headers({
      "webhook-id": "msg_dbwebhook",
      "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      "webhook-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(authorize({ headers: h })).toMatchObject({ ok: false, reason: "signature mismatch" });
  });
});
