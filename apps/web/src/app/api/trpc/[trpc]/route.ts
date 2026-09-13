import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import * as Sentry from "@sentry/nextjs";
import { cookies } from "next/headers";
import { ACTIVE_ORG_COOKIE, appRouter, createContext } from "@corridor/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { drainDueJobs, scheduleJobTail } from "@/lib/jobs";

export const runtime = "nodejs";

const handler = async (req: Request) => {
  const [supabase, cookieStore] = await Promise.all([createSupabaseServerClient(), cookies()]);
  const res = await fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () =>
      createContext({
        headers: req.headers,
        supabase,
        activeOrgCookie: cookieStore.get(ACTIVE_ORG_COOKIE)?.value ?? null,
      }),
    onError: ({ path, error }) => {
      if (process.env.NODE_ENV === "development")
        console.error(`tRPC ${path ?? "<no-path>"}:`, error.message);
      Sentry.captureException(error, {
        tags: { component: "trpc", procedure: path ?? "unknown" },
      });
    },
  });
  // Background work (customs decisions, scans) is processed right after the
  // response goes out: every request drains what is already due, and
  // mutations additionally keep a short-lived tail worker alive.
  drainDueJobs();
  if (req.method === "POST") scheduleJobTail();
  return res;
};

export { handler as GET, handler as POST };
