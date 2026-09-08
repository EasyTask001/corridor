import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authCookieOptions, persistSessionFrom } from "@corridor/auth";
import { env } from "@/lib/env";

/**
 * Server-side Supabase client bound to the request's httpOnly cookie session.
 * Use in Server Components, Route Handlers, Server Actions and tRPC context.
 */
export async function createSupabaseServerClient(options: { persist?: boolean } = {}) {
  const cookieStore = await cookies();
  // "Stay signed in": session cookies unless the person asked to be remembered.
  const persist = options.persist ?? persistSessionFrom(cookieStore);
  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, {
              ...authCookieOptions(options, persist),
              httpOnly: true,
              secure: process.env.NODE_ENV === "production",
              sameSite: "lax",
            });
          }
        } catch {
          // Called from a Server Component — cookies are refreshed by proxy.ts instead.
        }
      },
    },
  });
}
