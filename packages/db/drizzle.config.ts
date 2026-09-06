import { defineConfig } from "drizzle-kit";

/**
 * SQL migrations under supabase/migrations are the source of truth (they carry
 * RLS policies and functions Drizzle can't express). Drizzle Kit is used here
 * only for `drizzle-kit pull`/`check` style introspection against the DIRECT
 * (non-pooled) connection — never to generate/apply migrations.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres",
  },
  schemaFilter: ["public"],
  strict: true,
});
