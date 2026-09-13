import { describe, expect, it } from "vitest";
import { buildCspHeader, cspHeaderName, generateNonce } from "./csp";

describe("generateNonce", () => {
  it("produces a fresh value every call", () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});

describe("buildCspHeader", () => {
  it("embeds the nonce in script-src with strict-dynamic", () => {
    const header = buildCspHeader("abc123", {});
    expect(header).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
  });

  it("keeps style-src unsafe-inline since nonces don't cover React's style attribute", () => {
    const header = buildCspHeader("n", {});
    expect(header).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("derives http and ws Supabase origins from NEXT_PUBLIC_SUPABASE_URL", () => {
    const header = buildCspHeader("n", { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" });
    expect(header).toContain("connect-src 'self' http://127.0.0.1:55321 ws://127.0.0.1:55321");
    expect(header).toContain("img-src 'self' data: blob: http://127.0.0.1:55321");
  });

  it("uses wss for an https Supabase project", () => {
    const header = buildCspHeader("n", { NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" });
    expect(header).toContain("connect-src 'self' https://abc.supabase.co wss://abc.supabase.co");
  });

  it("omits the Supabase origin entirely when the URL is missing or invalid", () => {
    const header = buildCspHeader("n", { NEXT_PUBLIC_SUPABASE_URL: "not-a-url" });
    expect(header).toContain("connect-src 'self' https://*.ingest.sentry.io");
    expect(header).toContain("img-src 'self' data: blob:;");
  });

  it("appends report-uri only when configured", () => {
    expect(buildCspHeader("n", {})).not.toContain("report-uri");
    expect(buildCspHeader("n", { CSP_REPORT_URI: "https://example.com/csp" })).toContain(
      "report-uri https://example.com/csp",
    );
  });

  it("omits upgrade-insecure-requests in report-only mode (Chrome logs a console error for it there)", () => {
    expect(buildCspHeader("n", {})).not.toContain("upgrade-insecure-requests");
    expect(buildCspHeader("n", { CSP_ENFORCE: "true" })).toContain("upgrade-insecure-requests");
  });

  it("allows unsafe-eval only in development, for React's dev-mode call-stack reconstruction", () => {
    expect(buildCspHeader("n", { NODE_ENV: "development" })).toContain("'strict-dynamic' 'unsafe-eval'");
    expect(buildCspHeader("n", { NODE_ENV: "production" })).not.toContain("unsafe-eval");
  });
});

describe("cspHeaderName", () => {
  it("defaults to report-only", () => {
    expect(cspHeaderName({})).toBe("Content-Security-Policy-Report-Only");
  });

  it("switches to the enforced header when CSP_ENFORCE=true", () => {
    expect(cspHeaderName({ CSP_ENFORCE: "true" })).toBe("Content-Security-Policy");
  });

  it("treats any other value as report-only", () => {
    expect(cspHeaderName({ CSP_ENFORCE: "1" })).toBe("Content-Security-Policy-Report-Only");
  });
});
