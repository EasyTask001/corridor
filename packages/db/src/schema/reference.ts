import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./core";

/** Global (non-tenant) customs code lookup — see migration 0018. */
export const ports = pgTable(
  "ports",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    regime: text("regime", { enum: ["ACE", "ACI"] }).notNull(),
    kind: text("kind", {
      enum: ["port_of_entry", "in_bond_destination", "cbsa_office", "firms", "sublocation"],
    }).notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    stateProvince: text("state_province"),
    country: text("country", { enum: ["US", "CA"] }).notNull(),
    parentCode: text("parent_code"),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    unique("ports_regime_kind_code_key").on(t.regime, t.kind, t.code),
    index("ports_search_idx").using(
      "gin",
      sql`to_tsvector('simple', ${t.code} || ' ' || ${t.name})`,
    ),
  ],
);

export const organizationCarrierCodes = pgTable(
  "organization_carrier_codes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    regime: text("regime", { enum: ["ACE", "ACI"] }).notNull(),
    code: text("code").notNull(),
    label: text("label"),
    isDefault: boolean("is_default").notNull().default(false),
    status: text("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("organization_carrier_codes_org_idx").on(t.organizationId),
    unique("organization_carrier_codes_organization_id_regime_code_key").on(
      t.organizationId,
      t.regime,
      t.code,
    ),
    uniqueIndex("organization_carrier_codes_default_unique")
      .on(t.organizationId, t.regime)
      .where(sql`${t.isDefault}`),
  ],
);
