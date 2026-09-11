import { sql } from "drizzle-orm";
import type { Address } from "@corridor/domain";
import {
  bigint,
  boolean,
  customType,
  foreignKey,
  index,
  jsonb,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Postgres `citext` (case-insensitive text). Drizzle has no native type, so the
 * columns that are citext in SQL declare it here — otherwise `drizzle-kit`
 * introspection reports drift on every email column.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

/** Reference to Supabase's auth.users — never queried directly, only for FKs. */
export const authSchema = pgSchema("auth");
export const authUsers = authSchema.table("users", {
  id: uuid("id").primaryKey(),
  email: text("email"),
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const organizations = pgTable("organizations", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  scacCode: text("scac_code"),
  canadianCarrierCode: text("canadian_carrier_code"),
  usDotNumber: text("us_dot_number"),
  mcNumber: text("mc_number"),
  filerCode: text("filer_code"),
  billingEmail: citext("billing_email"),
  stripeCustomerId: text("stripe_customer_id").unique(),
  subscriptionPlan: text("subscription_plan", {
    enum: ["trial", "starter", "professional", "enterprise"],
  })
    .notNull()
    .default("trial"),
  subscriptionStatus: text("subscription_status", {
    enum: ["trialing", "active", "past_due", "canceled", "incomplete"],
  })
    .notNull()
    .default("trialing"),
  /** 0024 — Avaal's "simple" driver sheet: no commodity lines. */
  simpleDriverSheet: boolean("simple_driver_sheet").notNull().default(false),
  // 0025 — company profile
  timezone: text("timezone").notNull().default("America/Toronto"),
  billingAddress: jsonb("billing_address").$type<Address>().notNull().default({}),
  includeParsInCargoNumbers: boolean("include_pars_in_cargo_numbers").notNull().default(false),
  dispatchEmails: text("dispatch_emails").array().notNull().default(sql`'{}'::text[]`),
  ...timestamps,
});

export const permissions = pgTable("permissions", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(),
  description: text("description").notNull().default(""),
  module: text("module").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable(
  "roles",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("roles_organization_id_idx").on(t.organizationId),
    uniqueIndex("roles_system_name_unique")
      .on(t.name)
      .where(sql`${t.organizationId} is null`),
    uniqueIndex("roles_org_name_unique")
      .on(t.organizationId, t.name)
      .where(sql`${t.organizationId} is not null`),
    uniqueIndex("roles_organization_name_unique")
      .on(t.organizationId, sql`lower(${t.name})`)
      .where(sql`${t.organizationId} is not null`),
    /** 0031 — target for the composite key on organization_members. */
    uniqueIndex("roles_id_organization_unique").on(t.id, t.organizationId),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionId] }),
    // 0030 — permission_id is never the leading column of the PK, so a
    // permission delete (cascade) has to scan without this.
    index("role_permissions_permission_id_idx").on(t.permissionId),
  ],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => authUsers.id, { onDelete: "cascade" }),
    /** FK is composite — see organization_members_role_org_fkey below. */
    roleId: uuid("role_id").notNull(),
    status: text("status", { enum: ["invited", "active", "suspended"] })
      .notNull()
      .default("invited"),
    invitedEmail: citext("invited_email"),
    inviteToken: text("invite_token").unique(),
    inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
    invitedBy: uuid("invited_by").references(() => authUsers.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("organization_members_user_id_idx").on(t.userId),
    index("organization_members_organization_id_idx").on(t.organizationId),
    // 0030 — joined directly in notify_organization() and the member-list
    // query; a restrict-delete of a role also has to scan for this.
    index("organization_members_role_id_idx").on(t.roleId),
    uniqueIndex("organization_members_org_user_unique")
      .on(t.organizationId, t.userId)
      .where(sql`${t.userId} is not null`),
    uniqueIndex("organization_members_org_invite_email_unique")
      .on(t.organizationId, t.invitedEmail)
      .where(sql`${t.status} = 'invited'`),
    // 0031
    index("organization_members_org_role_idx").on(t.organizationId, t.roleId),
    foreignKey({
      name: "organization_members_role_org_fkey",
      columns: [t.roleId, t.organizationId],
      foreignColumns: [roles.id, roles.organizationId],
    }).onDelete("restrict"),
  ],
);

export const userProfiles = pgTable("user_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  /** 0025 — SMS address for notification rules with the `sms` channel. */
  phone: text("phone"),
  ...timestamps,
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => authUsers.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    index("audit_log_entity_idx").on(t.organizationId, t.entityType, t.entityId),
  ],
);
