import { afterEach, describe, expect, it, vi } from "vitest";

describe("env", () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.EXPO_PUBLIC_API_URL;
  });

  it("throws a clear error when EXPO_PUBLIC_API_URL is unset", async () => {
    delete process.env.EXPO_PUBLIC_API_URL;
    await expect(import("./env")).rejects.toThrow(
      "EXPO_PUBLIC_API_URL is not set — copy .env.example to .env.local",
    );
  });

  it("exposes the value when set", async () => {
    process.env.EXPO_PUBLIC_API_URL = "http://10.0.0.5:3000";
    process.env.EXPO_PUBLIC_SUPABASE_URL = "http://x";
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "k";
    expect((await import("./env")).API_URL).toBe("http://10.0.0.5:3000");
  });
});
