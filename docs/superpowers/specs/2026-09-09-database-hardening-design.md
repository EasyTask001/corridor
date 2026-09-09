# Corridor database hardening — design

Status: architecture approved in chat on 2026-09-09; written spec awaiting review

## Why

The database review found a sound baseline—RLS on every public table, validated constraints,
pooled runtime connections, and broad integration coverage—but also found two reproducible
authorization escapes and several queue, transaction, query, and verification weaknesses.
The most serious defect is structural: tenant-owned child rows can reference parent rows from a
different organization. Some assigned-resource RLS policies then interpret that invalid
relationship as permission to read the foreign row. The review reproduced this for
movement-to-truck and shipment-to-partner relationships.

This change makes tenant consistency a database invariant, narrows the remotely exposed database
surface, makes job delivery explicitly at-least-once and idempotent, removes network waits from
database transactions, and aligns the main access paths with their indexes.

## Goals

1. No organization-owned row can reference an organization-owned parent from another tenant.
2. Browser and mobile clients use Supabase directly only for Auth, Storage, and the two anonymous
   SSO discovery functions. Business data goes through the Corridor API.
3. Every callable database function has an intentional ACL; every `security definer` has an empty
   search path and schema-qualified references.
4. Jobs are safely retryable, leased only while actively processed, and protected against stale
   workers finalizing reclaimed work.
5. No database transaction remains open across an external network call.
6. Application searches, list ordering, pagination, bulk writes, and foreign-key maintenance have
   supporting query shapes and indexes.
7. CI detects future violations of these invariants.

## Non-goals

- Replacing the PostgreSQL queue with an external broker.
- Removing RLS because business data is no longer exposed through PostgREST.
- Replacing Supabase Auth or Storage.
- Introducing an event-sourcing system or a second outbox table. `background_jobs` already has the
  correct durable grain and will be extended.
- Partitioning current tables. The live local dataset and reviewed access patterns do not justify
  that operational complexity.
- Dropping speculative indexes based only on the tiny local database's usage counters.

## Chosen architecture

### Backend-owned business data

Supabase PostgREST will expose a new `api` schema plus `graphql_public`, not `public`. The `api`
schema will contain only `sso_provider_for_email(text)` and `sso_enforced_for_email(text)`, both
explicitly executable by `anon` and `authenticated`. They return the minimum pre-login SSO
information already returned today and remain protected by the existing rate limiting.

The web SSO helper will call these functions through `supabase.schema("api").rpc(...)`. Session
bootstrap will stop selecting `organization_members`, `organizations`, `roles`, and
`user_profiles` through Supabase JS. After Supabase Auth validates the session, `createContext`
will load memberships, profile, and permissions through the existing direct PostgreSQL connection
inside `withRls`. The remaining backend calls to public RPCs—including organization creation,
invitation acceptance, Vault writes, and integration-secret reads—will be converted to direct SQL
calls under `withRls` or `withServiceRole`, according to their current trust boundary.

RLS remains enabled on all tenant tables. `withRls` continues to set the caller's JWT claims and
switch to the `authenticated` role, retaining the same database-enforced authorization for API
requests even though PostgREST cannot expose the tables remotely.

### Explicit privileges

A security migration will:

- create the `api` schema and grant schema usage only to the required Data API roles;
- revoke access to the new schema from `public` before adding the two allowlisted grants;
- revoke anonymous execution of `match_regulations`;
- revoke automatic future table, sequence, and function privileges for `anon`, `authenticated`,
  and `service_role` in exposed schemas;
- replace broad existing table privileges with explicit DML grants required by the operations that
  have RLS policies, excluding `TRUNCATE`, `REFERENCES`, and `TRIGGER` from application roles;
- preserve service access required by Supabase-managed infrastructure without altering the
  `auth`, `storage`, `realtime`, or extension schemas.

Every application-owned `security definer` in `public` or `api` will be recreated with
`set search_path = ''` and fully-qualified relations/functions. Functions remain in `public` when
they are internal implementation details because `public` will no longer be exposed. Function
execution will be revoked from `public` and re-granted only to its intended caller roles. Trigger
functions receive no direct application-role execution grant.

`record_usage` will no longer be a browser-callable metering endpoint. The API will record usage
as part of the trusted server operation that incurred it. Each usage record will gain a nullable
`source_event_id` used by new writes, with uniqueness on
`(organization_id, metric, source_event_id)` when the source is present. Retries therefore cannot
bill the same operation twice. Existing historical rows remain valid.

System-authored tables—usage records, audit log, integration events, and compliance alerts—will
have RLS grants and policies narrowed to the exact user operations the product supports. User
notification updates will be limited to read-state fields through a narrow function rather than a
general row update surface.

## Tenant referential integrity

### Invariant

For every foreign key between two tables that both contain `organization_id`, the child constraint
must include that organization column:

```sql
foreign key (parent_id, organization_id)
  references public.parent (id, organization_id)
```

The referenced parent must have a non-partial unique key on `(id, organization_id)`. The child will
have a supporting index beginning with `organization_id` and containing the foreign-key column,
unless an existing index already provides that shape.

This applies to all 39 tenant-to-tenant relationships currently in the catalog. Four are already
composite. The other 35 include relationships from commodities, compliance alerts, customs
submissions, generated documents, in-bond records/events, integration events, movement children,
movements, organization members, shipments, source documents, and seals to their tenant-owned
parents.

### Migration safety

The migration begins with preflight queries that raise a descriptive exception if any existing
child and parent organizations disagree. It never guesses which tenant owns inconsistent data.
After a clean preflight it adds the required parent unique keys, introduces composite foreign keys,
validates them, and removes the superseded single-column tenant foreign keys. Nullable parent IDs
remain nullable; a non-null ID must match the child's non-null organization.

The Drizzle schema will mirror every composite unique key, foreign key, and supporting index.
Regression tests will attempt both INSERT and UPDATE cross-tenant references for the two proven
exploits and representative relationship families. A catalog assertion will cover all remaining
relationships so the invariant cannot regress on a future table.

## Queue and outbox semantics

### Schema

`background_jobs` will be extended rather than replaced. It will gain:

- `idempotency_key text` for producer deduplication;
- `lease_token uuid` to identify one particular claim attempt;
- `lease_expires_at timestamptz` so expiry is explicit rather than inferred from `locked_at`;
- `heartbeat_at timestamptz` for observability.

A partial unique index on `(job_type, organization_id, idempotency_key)` for non-null keys prevents
duplicate logical jobs. Global jobs normalize their nullable organization in the index expression
so they are deduplicated too. Running-job partial indexes support lease expiry and per-organization
cap calculations. A retention function deletes succeeded/cancelled jobs older than 30 days and
failed jobs older than 90 days; the existing scheduled job endpoint invokes it once per daily
sweep.

### Processing contract

The worker claims one job immediately before processing it. Claiming remains an atomic
`FOR UPDATE SKIP LOCKED` update, but returns a fresh lease token. The claim transaction commits
before the handler starts. A heartbeat extends the expiry while long handlers are active.

Completion, retry, and failure updates all require both job ID and lease token. If the lease was
reclaimed, the obsolete worker's final update affects zero rows and cannot overwrite the newer
attempt. Retries use bounded exponential backoff with jitter. Exhausted jobs remain visible in the
existing `failed` state, which serves as the dead-letter queue.

Producers must supply deterministic idempotency keys for jobs whose duplication has a side effect.
Document extraction uses the document ID plus extraction revision; customs jobs use the submission
or movement transition identity; notifications use the notification/channel identity; scheduled
singleton work uses its schedule window. The document-extraction sweep becomes a single
insert-select with conflict handling rather than a select-then-insert race.

### External effects

Every job handler receives the database pool rather than an already-open transaction. Database-only
work opens a short `withServiceRole` transaction. Networked workflows are split into:

1. a short transaction that reads and validates a versioned snapshot;
2. the external request with no database transaction open;
3. a short conditional transaction that records the response and applies it only if the expected
   state/version still matches.

Business transactions enqueue notification jobs in `background_jobs` before commit. Email, SMS,
push, customs, Stripe, and AI calls happen only in workers after that commit. Delivery handlers use
the job idempotency key when a provider supports it and locally record the provider result before
the job is finalized.

Application-role defaults will set finite statement, lock, and idle-in-transaction timeouts.
Worker operations that legitimately need more time can set a scoped statement timeout, but no
network wait is protected by holding a database transaction open.

## Query and write-path design

### Search

The existing UI implements substring search, so names and operational identifiers will use
`pg_trgm`, not unused text-vector indexes. The migration enables the trusted extension if needed
and adds GIN trigram indexes matching the exact lower/coalesce expressions used by movement,
shipment, partner, driver, truck, port, and in-bond searches. Search input will require at least
three non-whitespace characters for the broad substring path; shorter identifier input uses exact
or left-anchored matching supported by B-tree indexes.

The application will use the same normalized expression as each index. The five unused
`to_tsvector` indexes for these substring paths will be removed. Regulation and knowledge search
retain vector/full-text semantics appropriate to document content.

### Pagination and ordering

Every ordinary list endpoint currently using OFFSET will accept an opaque cursor composed of the
complete ordering tuple and will fetch `pageSize + 1` rows. Responses return `nextCursor` when
another page exists. Ordering always includes `id` as a unique tie-breaker. Corridor-owned web and
mobile callers will move to the cursor contract in the same change; deep OFFSET execution will be
removed rather than retained as an unbounded fallback.

Updated-first lists use `(updated_at desc, id desc)` and matching
`(organization_id, updated_at desc, id desc)` indexes. Created-first lists follow the equivalent
created-at shape. Reports that require a fixed result cap use a deterministic keyset loop or one
bounded query, not page-number OFFSET.

Crossing time becomes a stored generated `crossing_at` value equal to
`coalesce(scheduled_crossing_at, created_at)`, with an organization/order index. Crossing report
child data is preaggregated once by movement in CTEs/lateral subqueries instead of executing many
correlated scalar subqueries per result row.

### Bulk writes

CSV validation remains in application code. Valid shipments and commodities are inserted in
multi-row chunks of at most 500 rows per statement inside the existing atomic import transaction.
Commodity starting line numbers are loaded for all affected shipments in one grouped query and
computed in memory before batched insertion. Usage reporting uses one set-based update from the
provider results. Compliance scans prefetch existing alerts per organization, calculate changes,
and perform batched inserts/updates in bounded entity chunks. Registry bulk status changes use one
set-based update with `returning`, followed by batched audit writes and bounded post-commit effects.

## Index hardening and cleanup

After composite foreign-key conversion, a catalog-driven migration adds a leading-column index for
every remaining foreign key that lacks one. Existing composites are reused when they satisfy both
FK maintenance and application queries. Authentication actor/user references are indexed because
account deletion and cascading checks search the child side by user ID without an organization
predicate.

The migration removes only indexes that are structurally redundant without relying on workload
guesswork: the obsolete case-sensitive role-name uniqueness and standalone movement-amendment and
seal movement prefixes already covered by equivalent unique indexes. Other overlap candidates stay
until production statistics spanning a full business cycle justify removal.

## Verification design

The schema mirror verifier will compare more than table and index names. It will compare column
defaults, nullability, primary/unique/check/foreign-key constraints, FK actions, index method,
ordered keys, expressions, predicates, included columns, and operator classes using Drizzle table
configuration and `pg_catalog`.

A separate catalog integration test will assert database-only properties that Drizzle does not
model as application schema:

- every tenant table has RLS enabled;
- every tenant-to-tenant FK includes `organization_id`;
- every FK has an appropriate child-side index or a named, documented allowlist entry;
- every security definer has an empty search path;
- functions executable by `anon` exactly match the SSO allowlist;
- exposed schemas exactly match `api` and `graphql_public`;
- system-authored tables have no unintended authenticated write policies.

Behavioral integration tests cover cross-tenant INSERT/UPDATE rejection, anonymous RPC denial,
SSO discovery through `api`, usage idempotency, producer deduplication, lease heartbeat/reclaim,
stale-worker completion rejection, retry/dead-letter transitions, and transaction-free provider
calls. Query tests verify cursor continuity with duplicate timestamps and confirm generated search
and crossing expressions match their indexes.

Final verification is a clean database reset and seed followed by mirror verification, database
lint, unit tests, integration tests, type checking, linting, and formatting checks. Representative
search, list, queue, and crossing queries will be inspected with `EXPLAIN (ANALYZE, BUFFERS)` on
seeded fixture volumes large enough to make index selection meaningful.

## Delivery and rollback

The work will be delivered as ordered, independently reviewable concerns:

1. tenant composite keys/FKs and cross-tenant tests;
2. exposed-schema, function, privilege, and system-write hardening;
3. job leases, idempotency, retention, and transaction-free handlers;
4. search, cursor pagination, bulk operations, and query indexes;
5. verifier/catalog assertions and documentation updates.

Migrations are additive before they remove superseded constraints or indexes. A production rollout
must run the cross-tenant preflight before deployment and take a database backup. If preflight finds
inconsistent rows, deployment stops for an explicit data-repair decision. Application changes that
depend on new columns are deployed only after the additive migration exists. Removing `public` from
the exposed schemas occurs only after the context and SSO compatibility changes are deployed
together.

Rollback restores application compatibility and schema exposure first; it does not remove newly
validated tenant constraints because doing so would reintroduce the security defect. Queue columns
and indexes can remain harmlessly during an application rollback.

## Success criteria

- Both previously reproduced cross-tenant disclosure paths fail at FK enforcement.
- No public business table is reachable over PostgREST.
- Anonymous callers can execute only the two rate-limited SSO discovery functions.
- Retrying or concurrently producing the same logical job yields one active job/effect.
- A stale worker cannot finalize a job after another worker reclaims it.
- No external-provider request runs while a database transaction is open.
- All first-party list callers use cursor pagination and matching composite indexes.
- Imports and periodic sweeps perform bounded, set-based database work.
- Every FK is indexed or explicitly allowlisted with a documented reason.
- The full clean-reset verification suite passes and the worktree contains only intentional files.
