import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cronAuthFailure } from "./cron-auth";

const SECRET = "s3cr3t-cron-token";

const request = (authorization?: string) =>
  new Request("https://corridor.test/api/jobs/process", {
    headers: authorization ? { authorization } : {},
  });

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("cronAuthFailure", () => {
  it("is 503 when no CRON_SECRET is configured, whatever the caller sends", async () => {
    for (const req of [request(), request(`Bearer ${SECRET}`)]) {
      const denied = cronAuthFailure(req);
      expect(denied?.status).toBe(503);
      await expect(denied!.json()).resolves.toEqual({ error: "cron secret is not configured" });
    }
  });

  it("does not relax the missing-secret rule outside production", () => {
    // The whole point of the fix: NODE_ENV must not be an authorisation input.
    const previous = process.env.NODE_ENV;
    Object.assign(process.env, { NODE_ENV: "development" });
    try {
      expect(cronAuthFailure(request())?.status).toBe(503);
    } finally {
      Object.assign(process.env, { NODE_ENV: previous });
    }
  });

  it("is 401 for a wrong secret, a missing header, and a same-length near miss", async () => {
    process.env.CRON_SECRET = SECRET;
    const cases = [
      request(),
      request("Bearer nope"),
      request(`Bearer ${SECRET.slice(0, -1)}X`),
      request(SECRET.slice(0, -1)),
    ];
    for (const req of cases) {
      const denied = cronAuthFailure(req);
      expect(denied?.status).toBe(401);
      await expect(denied!.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });

  it("authorises the correct secret, with or without the Bearer prefix", () => {
    process.env.CRON_SECRET = SECRET;
    expect(cronAuthFailure(request(`Bearer ${SECRET}`))).toBeNull();
    expect(cronAuthFailure(request(SECRET))).toBeNull();
  });
});

describe("cron routes", () => {
  const source = (path: string) =>
    readFileSync(fileURLToPath(new URL(`../app/api/jobs/${path}`, import.meta.url)), "utf8");

  it("both cron routes authorise through the shared helper, with no NODE_ENV bypass", () => {
    for (const route of ["process/route.ts", "expiry-scan/route.ts"]) {
      const text = source(route);
      expect(text).toContain("cronAuthFailure(req)");
      expect(text).not.toContain("NODE_ENV");
    }
  });
});
