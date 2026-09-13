import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getUser = vi.fn(() => Promise.resolve({ data: { user: null } }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));
vi.mock("@corridor/auth", () => ({
  authCookieOptions: (options: unknown) => options,
  persistSessionFrom: () => true,
}));

const { proxy } = await import("./proxy");

function request(path: string) {
  return new NextRequest(new URL(path, "https://corridor.test"));
}

function nonceOf(res: Response, headerName: string) {
  return res.headers.get(headerName)?.match(/'nonce-([^']+)'/)?.[1];
}

afterEach(() => {
  getUser.mockClear();
  delete process.env.CSP_ENFORCE;
});

describe("proxy CSP header", () => {
  it("ships report-only by default, with a nonce embedded in script-src", async () => {
    const res = await proxy(request("/track"));
    const header = res.headers.get("Content-Security-Policy-Report-Only");
    expect(header).toBeTruthy();
    expect(header).toContain("script-src 'self' 'nonce-");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("generates a fresh nonce for every request", async () => {
    const first = await proxy(request("/track"));
    const second = await proxy(request("/track"));
    const a = nonceOf(first, "Content-Security-Policy-Report-Only");
    const b = nonceOf(second, "Content-Security-Policy-Report-Only");
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("switches to the enforced header name when CSP_ENFORCE=true", async () => {
    process.env.CSP_ENFORCE = "true";
    const res = await proxy(request("/track"));
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
  });

  it("still sets the header on a redirect response", async () => {
    const res = await proxy(request("/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy();
  });
});
