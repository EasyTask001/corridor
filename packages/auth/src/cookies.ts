/**
 * "Stay signed in" (Task 13). Supabase's SSR helper writes the auth cookies
 * with a long max-age; a person who leaves the box unchecked gets session
 * cookies instead, which the browser drops when it closes. The choice itself
 * is remembered in a small cookie the web app reads on every refresh.
 */
export const PERSIST_SESSION_COOKIE = "corridor-persist";
export const PERSIST_SESSION_MAX_AGE = 60 * 60 * 24 * 365;

export interface AuthCookieOptions {
  maxAge?: number;
  expires?: Date | number | string;
  [key: string]: unknown;
}

/** Apply the choice: keep Supabase's lifetime, or strip it to a session cookie. */
export function authCookieOptions<T extends AuthCookieOptions>(options: T, persist: boolean): T {
  if (persist) return options;
  const rest = { ...options };
  delete rest.maxAge;
  delete rest.expires;
  return rest;
}

/** Read the choice back from the request's cookies. */
export function persistSessionFrom(cookies: { get(name: string): { value: string } | undefined }) {
  return cookies.get(PERSIST_SESSION_COOKIE)?.value === "1";
}
