import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { resolveUser, toSessionUser } from "./session";

const user = { id: "u1", email: "d@corridor.test", user_metadata: { display_name: "Dee" } } as unknown as User;
const client = (over: Partial<{ getUser: unknown; getSession: unknown }>) =>
  ({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }), getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "jwt-cookie" } } }), ...over } }) as unknown as SupabaseClient;

describe("toSessionUser", () => {
  it("prefers the explicit display name, then user_metadata, then null", () => {
    expect(toSessionUser(user, "Profile")).toEqual({ id: "u1", email: "d@corridor.test", displayName: "Profile" });
    expect(toSessionUser(user).displayName).toBe("Dee");
    expect(toSessionUser({ ...user, user_metadata: {} } as User).displayName).toBeNull();
    expect(toSessionUser({ ...user, email: undefined } as User).email).toBeNull();
  });
});

describe("resolveUser", () => {
  it("validates a bearer token with getUser(token) and echoes the token back", async () => {
    const c = client({});
    await expect(resolveUser(c, "jwt-bearer")).resolves.toEqual({ user, accessToken: "jwt-bearer" });
    expect(c.auth.getUser).toHaveBeenCalledWith("jwt-bearer");
    expect(c.auth.getSession).not.toHaveBeenCalled();
  });
  it("returns null for a rejected bearer token", async () => {
    const c = client({ getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { message: "bad" } }) });
    await expect(resolveUser(c, "nope")).resolves.toBeNull();
  });
  it("uses the cookie session's access token when there is no bearer", async () => {
    await expect(resolveUser(client({}))).resolves.toEqual({ user, accessToken: "jwt-cookie" });
  });
  it("returns null when getUser succeeds but there is no session (stale cookie)", async () => {
    const c = client({ getSession: vi.fn().mockResolvedValue({ data: { session: null } }) });
    await expect(resolveUser(c)).resolves.toBeNull();
  });
});
