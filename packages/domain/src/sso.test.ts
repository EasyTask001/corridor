import { describe, expect, it } from "vitest";
import { emailDomain, ssoConfigureInput, ssoDomain } from "./sso";

describe("emailDomain", () => {
  it("lower-cases and trims the domain part", () => {
    expect(emailDomain("  Dispatch@ACME.Com ")).toBe("acme.com");
  });

  it("takes the part after the last @", () => {
    expect(emailDomain('"odd@name"@sub.acme.com')).toBe("sub.acme.com");
  });

  it("rejects anything that is not an address with a usable domain", () => {
    for (const input of [
      "",
      "acme.com", // no local part
      "@acme.com", // empty local part
      "dispatch@", // no domain
      "dispatch@localhost", // no dot: would claim every bare hostname
      "dispatch@acme .com", // whitespace inside
      "dispatch@-acme.com", // leading hyphen label
      "dispatch@acme.com.", // trailing dot
      "dispatch@acme.com/path",
      "dispatch@acme.com:443",
    ]) {
      expect(emailDomain(input), input).toBeNull();
    }
  });
});

describe("ssoDomain", () => {
  it("accepts multi-label domains and normalises case", () => {
    expect(ssoDomain.parse(" Acme.CO.UK ")).toBe("acme.co.uk");
  });

  it("rejects wildcards, schemes and bare labels", () => {
    for (const input of ["*.acme.com", "https://acme.com", "com", "acme_co.com"]) {
      expect(ssoDomain.safeParse(input).success, input).toBe(false);
    }
  });
});

describe("ssoConfigureInput", () => {
  const base = { domains: ["acme.com"], enforced: false };

  it("accepts a metadata URL", () => {
    const parsed = ssoConfigureInput.parse({
      ...base,
      metadataUrl: "https://idp.acme.com/metadata",
    });
    expect(parsed.domains).toEqual(["acme.com"]);
    expect(parsed.enforced).toBe(false);
  });

  it("accepts metadata XML", () => {
    expect(
      ssoConfigureInput.safeParse({ ...base, metadataXml: "<EntityDescriptor/>" }).success,
    ).toBe(true);
  });

  it("requires exactly one of URL / XML", () => {
    expect(ssoConfigureInput.safeParse(base).success).toBe(false);
    expect(
      ssoConfigureInput.safeParse({
        ...base,
        metadataUrl: "https://idp.acme.com/metadata",
        metadataXml: "<EntityDescriptor/>",
      }).success,
    ).toBe(false);
  });

  it("refuses a plaintext metadata URL", () => {
    expect(
      ssoConfigureInput.safeParse({ ...base, metadataUrl: "http://idp.acme.com/metadata" }).success,
    ).toBe(false);
  });

  it("refuses an empty or duplicated domain list", () => {
    const url = "https://idp.acme.com/metadata";
    expect(ssoConfigureInput.safeParse({ domains: [], metadataUrl: url }).success).toBe(false);
    expect(
      ssoConfigureInput.safeParse({ domains: ["acme.com", "ACME.com"], metadataUrl: url }).success,
    ).toBe(false);
  });

  it("defaults enforced to false", () => {
    const parsed = ssoConfigureInput.parse({
      domains: ["acme.com"],
      metadataUrl: "https://idp.acme.com/metadata",
    });
    expect(parsed.enforced).toBe(false);
  });
});
