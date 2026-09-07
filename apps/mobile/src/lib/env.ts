/**
 * Every value the driver app is allowed to hold. `EXPO_PUBLIC_*` variables are
 * inlined into the JS bundle by Metro, so nothing secret may ever appear here:
 * the Supabase anon key is public by design, and the API URL is not a secret.
 * The service-role key, Stripe keys and model keys stay on the server.
 */
const required = (name: string, value: string | undefined) => {
  if (!value) {
    console.warn(`[corridor] ${name} is not set — copy .env.example to .env.local`);
  }
  return value ?? "";
};

export const API_URL = required("EXPO_PUBLIC_API_URL", process.env.EXPO_PUBLIC_API_URL);
export const SUPABASE_URL = required(
  "EXPO_PUBLIC_SUPABASE_URL",
  process.env.EXPO_PUBLIC_SUPABASE_URL,
);
export const SUPABASE_ANON_KEY = required(
  "EXPO_PUBLIC_SUPABASE_ANON_KEY",
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
);

/** Mirrors `ACTIVE_ORG_HEADER` in `packages/api/src/context.ts` (kept as a literal so no server code is bundled). */
export const ACTIVE_ORG_HEADER = "x-corridor-org";
