import { afterEach, describe, expect, it, vi } from "vitest";

const collectReadiness = vi.fn();
vi.mock("@corridor/api", () => ({ collectReadiness: (...args: unknown[]) => collectReadiness(...args) }));
vi.mock("@corridor/db", () => ({ getDb: () => ({}) }));

const { GET } = await import("./route");

const SECRET = "s3cr3t-readiness-token";
const FULL_RESULT = {
  ok: true,
  service: "corridor-web",
  at: "2026-09-13T00:00:00.000Z",
  checks: { postgres: { ok: true }, jobs: { ok: true, queueDepth: 3 } },
};

const request = (authorization?: string) =>
  new Request("https://corridor.test/api/ready", {
    headers: authorization ? { authorization } : {},
  });

afterEach(() => {
  delete process.env.READINESS_SECRET;
  collectReadiness.mockReset();
});

describe("GET /api/ready", () => {
  it("returns only { ok } without a READINESS_SECRET configured, even with a bearer token", async () => {
    collectReadiness.mockResolvedValue(FULL_RESULT);
    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("returns only { ok } for an unauthenticated caller once a secret is configured", async () => {
    process.env.READINESS_SECRET = SECRET;
    collectReadiness.mockResolvedValue(FULL_RESULT);
    const res = await GET(request());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("returns only { ok } for a wrong bearer token", async () => {
    process.env.READINESS_SECRET = SECRET;
    collectReadiness.mockResolvedValue(FULL_RESULT);
    const res = await GET(request("Bearer wrong"));
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("returns the full readiness body for the correct bearer token", async () => {
    process.env.READINESS_SECRET = SECRET;
    collectReadiness.mockResolvedValue(FULL_RESULT);
    const res = await GET(request(`Bearer ${SECRET}`));
    await expect(res.json()).resolves.toEqual(FULL_RESULT);
  });

  it("mirrors the underlying ok/status even in the shallow body", async () => {
    collectReadiness.mockResolvedValue({ ...FULL_RESULT, ok: false });
    const res = await GET(request());
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ok: false });
  });

  it("never sets Cache-Control to anything cacheable", async () => {
    collectReadiness.mockResolvedValue(FULL_RESULT);
    const res = await GET(request());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("fails closed to { ok: false } on an unexpected error, without configuration detail leaking", async () => {
    process.env.READINESS_SECRET = SECRET;
    collectReadiness.mockRejectedValue(new Error("connection refused: password auth failed"));
    const res = await GET(request()); // no bearer — shallow path
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ ok: false });
    expect(JSON.stringify(body)).not.toMatch(/password|connection refused/);
  });

  it("gives the full error shape only to an authorised caller", async () => {
    process.env.READINESS_SECRET = SECRET;
    collectReadiness.mockRejectedValue(new Error("boom"));
    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      service: "corridor-web",
      at: expect.any(String),
      checks: { postgres: { ok: false } },
    });
  });
});
