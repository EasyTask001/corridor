import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@corridor/api";
import { ACTIVE_ORG_HEADER, API_URL } from "./env";
import { supabase } from "./supabase";

/**
 * The same router the web app calls, reached over `Authorization: Bearer` —
 * `createContext` resolves a bearer caller exactly like a cookie session, so
 * every permission check, RLS policy and audit row behaves identically.
 *
 * `AppRouter` is imported **type-only**: no server code reaches the bundle.
 */
let activeOrganizationId: string | null = null;

export function setActiveOrganizationId(id: string | null) {
  activeOrganizationId = id;
}

export function getActiveOrganizationId() {
  return activeOrganizationId;
}

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${API_URL}/api/trpc`,
      transformer: superjson,
      headers: async () => {
        // getSession() refreshes an expired access token before handing it back.
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        return {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(activeOrganizationId ? { [ACTIVE_ORG_HEADER]: activeOrganizationId } : {}),
        };
      },
    }),
  ],
});

export type TrpcClient = typeof trpc;
