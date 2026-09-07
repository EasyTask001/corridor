import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./core";

/**
 * Mirror of `organization_sso` (migration 0014) — which organization owns which
 * Supabase Auth SAML provider, the email domains it claims, and whether
 * password sign-in is switched off for them.
 *
 * `providerId` is GoTrue's provider uuid, or a synthetic `mock-sso-…` id when
 * the wrapper is running without a SAML-capable Auth instance. RLS gates every
 * statement on `organization.manage`; the login page reaches the domain
 * mapping only through the SECURITY DEFINER resolvers, never this table.
 */
export const organizationSso = pgTable(
  "organization_sso",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    domains: text("domains").array().notNull(),
    enforced: boolean("enforced").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("organization_sso_domains_idx").using("gin", t.domains)],
);
