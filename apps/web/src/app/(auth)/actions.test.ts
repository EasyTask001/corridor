/**
 * The server-side half of "Require SSO".
 *
 * The login form hides the password field for an enforced domain, but that is
 * only decoration: these tests are what proves a scripted POST — or a form that
 * kept the field because the hint lookup was rate-limited — cannot get a
 * password past the gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SsoModule from "@/lib/sso";

const passwordSignInBlockedFor = vi.fn<(email: string) => Promise<string | null>>();
const signInWithPassword = vi.fn();
const signUp = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});

vi.mock("@/lib/sso", async (importOriginal) => ({
  ...(await importOriginal<typeof SsoModule>()),
  passwordSignInBlockedFor: (email: string) => passwordSignInBlockedFor(email),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ auth: { signInWithPassword, signUp } }),
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
const cookieSet = vi.fn();
const cookieDelete = vi.fn();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({ set: cookieSet, delete: cookieDelete, get: () => undefined, getAll: () => [] }),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:55321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-key";

const { signIn, signUp: signUpAction } = await import("./actions");
const { SSO_REQUIRED_MESSAGE, SSO_CHECK_FAILED_MESSAGE } = await import("@/lib/sso");

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const CREDENTIALS = { email: "dispatch@acme.test", password: "corridor-demo", next: "/dashboard" };
const SIGNUP = { ...CREDENTIALS, displayName: "Dispatcher" };

beforeEach(() => {
  passwordSignInBlockedFor.mockReset();
  signInWithPassword.mockReset().mockResolvedValue({ error: null });
  signUp.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  redirect.mockClear();
  cookieSet.mockClear();
  cookieDelete.mockClear();
});

describe("signIn", () => {
  it("refuses a password on an enforced domain and never attempts the login", async () => {
    passwordSignInBlockedFor.mockResolvedValue(SSO_REQUIRED_MESSAGE);
    await expect(signIn(null, form(CREDENTIALS))).resolves.toEqual({
      error: SSO_REQUIRED_MESSAGE,
    });
    expect(passwordSignInBlockedFor).toHaveBeenCalledWith("dispatch@acme.test");
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("refuses when the enforcement check itself failed (fails closed)", async () => {
    passwordSignInBlockedFor.mockResolvedValue(SSO_CHECK_FAILED_MESSAGE);
    await expect(signIn(null, form(CREDENTIALS))).resolves.toEqual({
      error: SSO_CHECK_FAILED_MESSAGE,
    });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("signs in normally when the domain is not enforced", async () => {
    passwordSignInBlockedFor.mockResolvedValue(null);
    await expect(signIn(null, form(CREDENTIALS))).rejects.toThrow("REDIRECT:/dashboard");
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "dispatch@acme.test",
      password: "corridor-demo",
    });
  });

  it("checks enforcement against the normalised address", async () => {
    passwordSignInBlockedFor.mockResolvedValue(null);
    await expect(
      signIn(null, form({ ...CREDENTIALS, email: "  Dispatch@ACME.test " })),
    ).rejects.toThrow("REDIRECT:/dashboard");
    expect(passwordSignInBlockedFor).toHaveBeenCalledWith("dispatch@acme.test");
  });

  it("does not reach the check for input that fails validation", async () => {
    await expect(signIn(null, form({ email: "nope", password: "short" }))).resolves.toMatchObject({
      error: expect.any(String),
    });
    expect(passwordSignInBlockedFor).not.toHaveBeenCalled();
  });

  it("remembers the session only when 'Stay signed in' is ticked", async () => {
    passwordSignInBlockedFor.mockResolvedValue(null);
    await expect(signIn(null, form({ ...CREDENTIALS, remember: "on" }))).rejects.toThrow("REDIRECT:/dashboard");
    expect(cookieSet).toHaveBeenCalledWith("corridor-persist", "1", expect.objectContaining({ httpOnly: true, maxAge: 31536000 }));
    cookieSet.mockClear();
    await expect(signIn(null, form(CREDENTIALS))).rejects.toThrow("REDIRECT:/dashboard");
    expect(cookieSet).not.toHaveBeenCalled();
    expect(cookieDelete).toHaveBeenCalledWith("corridor-persist");
  });
});

describe("signUp", () => {
  it("refuses to create a password account on an enforced domain", async () => {
    passwordSignInBlockedFor.mockResolvedValue(SSO_REQUIRED_MESSAGE);
    await expect(signUpAction(null, form(SIGNUP))).resolves.toEqual({
      error: SSO_REQUIRED_MESSAGE,
    });
    expect(signUp).not.toHaveBeenCalled();
  });

  it("creates the account when the domain is not enforced", async () => {
    passwordSignInBlockedFor.mockResolvedValue(null);
    await expect(signUpAction(null, form(SIGNUP))).resolves.toEqual({
      message: "Check your email to confirm your account.",
    });
    expect(signUp).toHaveBeenCalledTimes(1);
  });
});
