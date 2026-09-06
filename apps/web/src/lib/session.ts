import { cache } from "react";
import { cookies, headers } from "next/headers";
import { ACTIVE_ORG_COOKIE, createContext, type Context } from "@corridor/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Request-scoped tRPC context for Server Components — deduped via React cache(). */
export const getRequestContext = cache(async (): Promise<Context> => {
  const [supabase, h, c] = await Promise.all([createSupabaseServerClient(), headers(), cookies()]);
  return createContext({
    headers: h,
    supabase,
    activeOrgCookie: c.get(ACTIVE_ORG_COOKIE)?.value ?? null,
  });
});

export async function getSession() {
  return (await getRequestContext()).session;
}
