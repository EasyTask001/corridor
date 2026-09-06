import "server-only";
import { appRouter, createCallerFactory } from "@corridor/api";
import { getRequestContext } from "@/lib/session";

const createCaller = createCallerFactory(appRouter);

/** Call tRPC procedures directly from Server Components (no HTTP hop). */
export async function api() {
  return createCaller(await getRequestContext());
}
