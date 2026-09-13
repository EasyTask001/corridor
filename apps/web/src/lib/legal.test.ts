import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_PRODUCTION_ENV } from "@corridor/api";
import { legal } from "./legal";

const KEYS = [
  "NEXT_PUBLIC_LEGAL_ENTITY_NAME",
  "NEXT_PUBLIC_LEGAL_JURISDICTION",
  "NEXT_PUBLIC_PRIVACY_EMAIL",
  "NEXT_PUBLIC_SECURITY_EMAIL",
  "NEXT_PUBLIC_SUPPORT_EMAIL",
  "NEXT_PUBLIC_LEGAL_REVIEWED_AT",
] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("legal", () => {
  it("falls back to development placeholders so pnpm dev never crashes on a missing var", () => {
    expect(legal.entityName).toBe("Corridor (development)");
    expect(legal.jurisdiction).toBe("Manitoba, Canada");
    expect(legal.privacyEmail).toBe("privacy@corridor.local");
    expect(legal.securityEmail).toBe("security@corridor.local");
    expect(legal.reviewedAt).toBeNull();
  });

  it("prefers NEXT_PUBLIC_PRIVACY_EMAIL over the support-email fallback", () => {
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL = "support@example.com";
    expect(legal.privacyEmail).toBe("support@example.com");
    process.env.NEXT_PUBLIC_PRIVACY_EMAIL = "privacy@example.com";
    expect(legal.privacyEmail).toBe("privacy@example.com");
  });

  it("reads every configured value", () => {
    process.env.NEXT_PUBLIC_LEGAL_ENTITY_NAME = "Acme Freight Inc.";
    process.env.NEXT_PUBLIC_LEGAL_JURISDICTION = "Ontario, Canada";
    process.env.NEXT_PUBLIC_SECURITY_EMAIL = "security@acme.example";
    process.env.NEXT_PUBLIC_LEGAL_REVIEWED_AT = "2026-10-01";
    expect(legal.entityName).toBe("Acme Freight Inc.");
    expect(legal.jurisdiction).toBe("Ontario, Canada");
    expect(legal.securityEmail).toBe("security@acme.example");
    expect(legal.reviewedAt).toBe("2026-10-01");
  });
});

describe("legal env vars are required in production", () => {
  it("are all listed in REQUIRED_PRODUCTION_ENV, so a placeholder never ships", () => {
    expect(REQUIRED_PRODUCTION_ENV).toEqual(
      expect.arrayContaining([
        "NEXT_PUBLIC_LEGAL_ENTITY_NAME",
        "NEXT_PUBLIC_LEGAL_JURISDICTION",
        "NEXT_PUBLIC_PRIVACY_EMAIL",
        "NEXT_PUBLIC_SECURITY_EMAIL",
      ]),
    );
  });
});
