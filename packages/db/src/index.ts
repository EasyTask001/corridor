export * from "./client";
export * from "./rls";
export * as schema from "./schema";
export {
  sql,
  eq,
  ne,
  and,
  or,
  not,
  desc,
  asc,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  ilike,
  like,
  gt,
  gte,
  lt,
  lte,
  between,
} from "drizzle-orm";
// Re-exported so consumers never import `drizzle-orm` directly: a second
// direct dependent would resolve its own drizzle instance under pnpm's
// peer-dependency hashing and the two sets of types would stop being
// assignable to each other.
export type { SQL } from "drizzle-orm";
export type { PgColumn, PgTable } from "drizzle-orm/pg-core";
