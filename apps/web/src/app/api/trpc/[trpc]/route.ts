import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { cookies } from "next/headers";
import { ACTIVE_ORG_COOKIE, appRouter, createContext } from "@corridor/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const handler = async (req: Request) => {
  const [supabase, cookieStore] = await Promise.all([createSupabaseServerClient(), cookies()]);
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () =>
      createContext({
        headers: req.headers,
        supabase,
        activeOrgCookie: cookieStore.get(ACTIVE_ORG_COOKIE)?.value ?? null,
      }),
    onError:
      process.env.NODE_ENV === "development"
        ? ({ path, error }) => console.error(`tRPC ${path ?? "<no-path>"}:`, error.message)
        : undefined,
  });
};

export { handler as GET, handler as POST };
