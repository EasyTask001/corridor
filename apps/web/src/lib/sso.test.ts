import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ rpc })),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:55321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-key";

const {
  lookupSso,
  passwordSignInBlockedFor,
  SSO_CHECK_FAILED_MESSAGE,
  SSO_REQUIRED_MESSAGE,
  NO_SSO,
} = await import("./sso");

/** Canned answers for the two resolvers, in call order. */
function resolvers(provider: unknown, enforced: unknown) {
  rpc.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === "sso_provider_for_email"
        ? { data: provider, error: null }
        : { data: enforced, error: null },
    ),
  );
}

beforeEach(() => {
  rpc.mockReset();
});

describe("lookupSso", () => {
  it("reports a configured, enforced domain", async () => {
    resolvers("11111111-2222-3333-4444-555555555555", true);
    expect(await lookupSso("dispatch@acme.test")).toEqual({ sso: true, enforced: true });
  });

  it("reports a configured domain that still allows passwords", async () => {
    resolvers("11111111-2222-3333-4444-555555555555", false);
    expect(await lookupSso("dispatch@acme.test")).toEqual({ sso: true, enforced: false });
  });

  it("reports nothing for an unconfigured domain, without trusting a stray flag", async () => {
    // enforced=true with no provider must never read as enforced: there is
    // nothing to sign in with.
    resolvers(null, true);
    expect(await lookupSso("nobody@example.test")).toEqual(NO_SSO);
  });

  it("does not call the resolvers for something that is not an address", async () => {
    expect(await lookupSso("not-an-address")).toEqual(NO_SSO);
    expect(await lookupSso("")).toEqual(NO_SSO);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("throws when a resolver errors, so each caller can choose its fallback", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(lookupSso("dispatch@acme.test")).rejects.toThrow("boom");
  });
});

describe("passwordSignInBlockedFor", () => {
  it("blocks an enforced domain", async () => {
    resolvers("provider-1", true);
    expect(await passwordSignInBlockedFor("dispatch@acme.test")).toBe(SSO_REQUIRED_MESSAGE);
  });

  it("allows a domain with SSO configured but not enforced", async () => {
    resolvers("provider-1", false);
    expect(await passwordSignInBlockedFor("dispatch@acme.test")).toBeNull();
  });

  it("allows a domain with no SSO at all", async () => {
    resolvers(null, false);
    expect(await passwordSignInBlockedFor("nobody@example.test")).toBeNull();
  });

  it("fails CLOSED when the check itself fails", async () => {
    rpc.mockRejectedValue(new Error("network down"));
    expect(await passwordSignInBlockedFor("dispatch@acme.test")).toBe(SSO_CHECK_FAILED_MESSAGE);
  });

  it("does not block an input with no usable domain", async () => {
    expect(await passwordSignInBlockedFor("not-an-address")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});
