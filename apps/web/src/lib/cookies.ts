/** The one cookie policy for everything the app sets itself (docs/security-review.md §2). */
export function appCookieOptions<T extends Record<string, unknown>>(
  extra: T = {} as T,
  nodeEnv = process.env.NODE_ENV,
) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: nodeEnv === "production",
    path: "/",
    ...extra,
  };
}
