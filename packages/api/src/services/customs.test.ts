import { describe, expect, it, vi } from "vitest";
import { parseCustomsCredentials } from "./customs";

describe("parseCustomsCredentials", () => {
  it("accepts the document store_integration_secret writes", () => {
    expect(parseCustomsCredentials(JSON.stringify({ apiKey: "k", apiSecret: "s" }))).toEqual({
      apiKey: "k",
      apiSecret: "s",
    });
    expect(parseCustomsCredentials(JSON.stringify({ accountId: "acct" }))).toEqual({
      accountId: "acct",
    });
  });

  it("drops fields that are not part of the contract", () => {
    expect(parseCustomsCredentials(JSON.stringify({ apiKey: "k", password: "nope" }))).toEqual({
      apiKey: "k",
    });
  });

  it("treats an absent, empty or blank secret as no credentials", () => {
    expect(parseCustomsCredentials(null)).toBeUndefined();
    expect(parseCustomsCredentials("")).toBeUndefined();
    expect(parseCustomsCredentials("{}")).toBeUndefined();
    expect(parseCustomsCredentials(JSON.stringify({ apiKey: "" }))).toBeUndefined();
  });

  it("degrades instead of throwing on a corrupt secret, and never echoes it", () => {
    const warn = vi.fn();
    expect(parseCustomsCredentials("not json at all", warn)).toBeUndefined();
    expect(parseCustomsCredentials(JSON.stringify({ apiKey: 42 }), warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [reason] of warn.mock.calls) {
      expect(reason).not.toContain("not json at all");
      expect(reason).not.toContain("42");
    }
  });
});
