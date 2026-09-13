import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SECURITY_EMAIL;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("GET /.well-known/security.txt", () => {
  it("publishes a Contact, Policy, and Expires field per RFC 9116", async () => {
    process.env.NEXT_PUBLIC_SECURITY_EMAIL = "security@example.com";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    const res = GET();
    const body = await res.text();
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(body).toContain("Contact: mailto:security@example.com");
    expect(body).toContain("Policy: https://app.example.com/legal/security");
    expect(body).toMatch(/Expires: \d{4}-\d{2}-\d{2}T/);
  });

  it("falls back to the dev security-email placeholder when unset", async () => {
    const body = await GET().text();
    expect(body).toContain("Contact: mailto:security@corridor.local");
  });
});
