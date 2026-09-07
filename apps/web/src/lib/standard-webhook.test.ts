import { describe, expect, it } from "vitest";
import {
  WEBHOOK_TOLERANCE_MS,
  signStandardWebhook,
  verifyStandardWebhook,
} from "./standard-webhook";

// A fixed vector: this signature was computed out-of-band from the secret,
// id, timestamp and body below, so the test pins the wire format itself
// rather than just round-tripping through our own signer.
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const ID = "msg_2xY3zQ7aBcDeFgHiJkLmNo";
const TIMESTAMP = 1700000000; // seconds
const NOW = TIMESTAMP * 1000;
const BODY =
  '{"type":"user.created","user":{"id":"6d1c8a2e-1c3a-4b6f-9a5e-2f7d0b3c4e51",' +
  '"email":"newuser@pathfinder.demo","user_metadata":{"display_name":"New User"}}}';
const SIGNATURE = "Sr2g54HCG76dVUJwH1LnCe+zg8wjlxBbvW1luEeat7I=";

function headers(overrides: Record<string, string | null> = {}) {
  const base: Record<string, string> = {
    "webhook-id": ID,
    "webhook-timestamp": String(TIMESTAMP),
    "webhook-signature": `v1,${SIGNATURE}`,
  };
  const h = new Headers();
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v !== null) h.set(k, v);
  }
  return h;
}

const verify = (opts: Partial<Parameters<typeof verifyStandardWebhook>[0]> = {}) =>
  verifyStandardWebhook({ secret: SECRET, body: BODY, headers: headers(), now: NOW, ...opts });

describe("verifyStandardWebhook", () => {
  it("accepts the known-good signature", () => {
    expect(verify()).toEqual({ ok: true });
  });

  it("accepts the secret with or without the whsec_ prefix", () => {
    expect(verify({ secret: SECRET.replace("whsec_", "") })).toEqual({ ok: true });
  });

  it("matches our own signer (same algorithm both directions)", () => {
    expect(signStandardWebhook({ secret: SECRET, body: BODY, id: ID, timestamp: TIMESTAMP })).toBe(
      `v1,${SIGNATURE}`,
    );
  });

  it("accepts a v1 entry alongside other versions (key rotation)", () => {
    const h = headers({ "webhook-signature": `v0,ZmFrZQ== v1,${SIGNATURE}` });
    expect(verify({ headers: h })).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    expect(verify({ body: BODY.replace("New User", "Admin User") })).toMatchObject({
      ok: false,
      reason: "signature mismatch",
    });
  });

  it("rejects a signature signed with a different secret", () => {
    const other = "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const h = headers({
      "webhook-signature": signStandardWebhook({
        secret: other,
        body: BODY,
        id: ID,
        timestamp: TIMESTAMP,
      }),
    });
    expect(verify({ headers: h })).toMatchObject({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a replayed id/timestamp pair reused for another body", () => {
    // Same headers, different payload — the id is part of the signed content.
    const h = headers({ "webhook-id": "msg_someoneElsesMessage" });
    expect(verify({ headers: h })).toMatchObject({ ok: false });
  });

  it("rejects a timestamp older than the tolerance window", () => {
    expect(verify({ now: NOW + WEBHOOK_TOLERANCE_MS + 1000 })).toMatchObject({
      ok: false,
      reason: "webhook-timestamp outside the tolerance window",
    });
  });

  it("rejects a timestamp too far in the future", () => {
    expect(verify({ now: NOW - WEBHOOK_TOLERANCE_MS - 1000 })).toMatchObject({ ok: false });
  });

  it("still accepts inside the tolerance window", () => {
    expect(verify({ now: NOW + WEBHOOK_TOLERANCE_MS - 1000 })).toEqual({ ok: true });
  });

  it.each([
    ["webhook-id", "missing webhook headers"],
    ["webhook-timestamp", "missing webhook headers"],
    ["webhook-signature", "missing webhook headers"],
  ])("rejects a request with no %s", (header, reason) => {
    expect(verify({ headers: headers({ [header]: null }) })).toMatchObject({ ok: false, reason });
  });

  it("rejects a non-numeric timestamp", () => {
    expect(verify({ headers: headers({ "webhook-timestamp": "yesterday" }) })).toMatchObject({
      ok: false,
      reason: "malformed webhook-timestamp",
    });
  });

  it("rejects a signature header with no v1 entry", () => {
    expect(verify({ headers: headers({ "webhook-signature": "v2,abcd" }) })).toMatchObject({
      ok: false,
      reason: "no v1 signature in webhook-signature",
    });
  });

  it("rejects an empty secret", () => {
    expect(verify({ secret: "whsec_" })).toMatchObject({ ok: false, reason: "secret is empty" });
  });

  it("rejects a signature of the wrong length without throwing", () => {
    expect(verify({ headers: headers({ "webhook-signature": "v1,c2hvcnQ=" }) })).toMatchObject({
      ok: false,
      reason: "signature mismatch",
    });
  });
});
