# Corridor Database Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the audited tenant-isolation defects and harden Corridor's database API, job processing, transaction boundaries, search, pagination, bulk writes, indexes, and schema verification.

**Architecture:** Business tables remain protected by RLS but leave PostgREST's exposed schema; only two SSO discovery RPCs remain in a dedicated `api` schema. Tenant ownership becomes a composite-FK invariant, and the existing `background_jobs` table becomes an idempotent, token-leased at-least-once outbox whose handlers perform network I/O outside database transactions.

**Tech Stack:** PostgreSQL/Supabase migrations, Drizzle ORM, TypeScript, tRPC, Zod, Vitest, React Query, Supabase JS.

**Spec:** `docs/superpowers/specs/2026-09-09-database-hardening-design.md`

## Global Constraints

- Migrations are append-only; begin at `0031` and mirror every schema change in `packages/db/src/schema/`.
- Every production behavior change follows red-green-refactor; integration tests must fail for the expected reason before implementation.
- Keep RLS on every tenant table and keep all user-scoped API database work inside `withRls`.
- Do not expose `public` through PostgREST; retain Supabase Auth and Storage.
- Do not add a second queue/outbox table; extend `background_jobs`.
- No provider request may execute inside an open database transaction.
- Use `set search_path = ''` and schema-qualified names in every security-definer function.
- Keep commits scoped to the task that produced them and never push without explicit authorization.

---

### Task 1: Enforce tenant ownership with composite foreign keys

**Files:**

- Create: `packages/db/src/tenant-integrity.integration.test.ts`
- Create: `supabase/migrations/0031_tenant_referential_integrity.sql`
- Modify: `packages/db/src/schema/core.ts`
- Modify: `packages/db/src/schema/documents.ts`
- Modify: `packages/db/src/schema/inbond.ts`
- Modify: `packages/db/src/schema/integrations.ts`
- Modify: `packages/db/src/schema/movements.ts`
- Modify: `packages/db/src/schema/registry.ts`
- Modify: `packages/db/src/schema/alerts.ts`

**Interfaces:**

- Consumes: existing `withRls`, seeded actors, and every public table containing `organization_id`.
- Produces: catalog invariant `tenant FK => child and parent organization_id are constrained together` and Drizzle composite `foreignKey(...)` definitions.

- [ ] **Step 1: Write the failing cross-tenant and catalog tests**

Create a Vitest integration file using the existing seeded-actor pattern. The behavioral tests must insert a foreign-org truck/partner as the service role, then assert these authenticated writes reject with a foreign-key error:

```ts
await expect(
  withRls(db, as(dispatcherA), (tx) =>
    tx.insert(movements).values({
      organizationId: dispatcherA.orgId,
      movementNumber: uniqueMovementNumber(),
      regime: "ACE",
      status: "draft",
      scheduledCrossingAt: new Date(),
      truckId: foreignTruck.id,
      createdBy: dispatcherA.userId,
    }),
  ),
).rejects.toThrow(/foreign key|violates/i);
```

Add the equivalent shipment `shipperId` and `consigneeId` cases and a catalog assertion whose result must be zero:

```sql
select count(*)
from pg_constraint fk
join pg_attribute child_org
  on child_org.attrelid = fk.conrelid and child_org.attname = 'organization_id'
join pg_attribute parent_org
  on parent_org.attrelid = fk.confrelid and parent_org.attname = 'organization_id'
where fk.contype = 'f'
  and not (child_org.attnum = any(fk.conkey) and parent_org.attnum = any(fk.confkey));
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @corridor/db exec vitest run --project integration src/tenant-integrity.integration.test.ts`

Expected: cross-tenant inserts succeed or the catalog count reports 34, proving the test catches the audited defect.

- [ ] **Step 3: Add the tenant-integrity migration**

In `0031`, first raise `23514` if any existing child-parent pair has different organizations. Add `(id, organization_id)` unique keys to the referenced tenant parents that lack them, then replace all 34 single-ID tenant-to-tenant FKs with composite constraints. Use this exact pattern for every relationship:

```sql
alter table public.movements
  drop constraint movements_truck_id_fkey,
  add constraint movements_truck_org_fkey
  foreign key (truck_id, organization_id)
  references public.trucks (id, organization_id);

create index if not exists movements_org_truck_idx
  on public.movements (organization_id, truck_id)
  where truck_id is not null;
```

Apply it to tenant parent links on commodities, commodity_hazmat, compliance_alerts,
customs_submissions, generated_documents, in_bond_events, in_bond_records, integration_events,
movement_amendments, movement_crew, movement_events, movement_suggestions, movement_trailers,
movements, organization_members, pars_rns_events, seals, shipments, and source_documents. Preserve
each existing `on delete` action.

- [ ] **Step 4: Mirror composite keys and FKs in Drizzle**

For each affected table, replace `.references(() => parent.id)` with a table-level foreign key:

```ts
foreignKey({
  columns: [t.truckId, t.organizationId],
  foreignColumns: [trucks.id, trucks.organizationId],
  name: "movements_truck_org_fkey",
});
```

Add named unique `(id, organizationId)` constraints only to referenced parent tables and reuse existing indexes where their leading keys already cover the FK lookup.

- [ ] **Step 5: Reset the database and verify GREEN**

Run: `pnpm exec supabase db reset && pnpm db:seed`

Run: `pnpm --filter @corridor/db exec vitest run --project integration src/tenant-integrity.integration.test.ts`

Expected: all cross-tenant writes reject and the catalog count is zero.

- [ ] **Step 6: Verify and commit**

Run: `pnpm --filter @corridor/db verify:mirror && pnpm db:lint && pnpm test:integration`

Commit:

```bash
git add supabase/migrations/0031_tenant_referential_integrity.sql packages/db/src/schema packages/db/src/tenant-integrity.integration.test.ts
git commit -m "fix(db): enforce tenant-safe foreign keys"
```

### Task 2: Restrict the Data API and database function surface

**Files:**

- Create: `supabase/migrations/0032_database_api_hardening.sql`
- Create: `packages/db/src/security-invariants.integration.test.ts`
- Modify: `supabase/config.toml`
- Modify: `apps/web/src/lib/sso.ts`
- Modify: `apps/web/src/lib/sso.test.ts`
- Modify: `packages/api/src/context.ts`
- Modify: `packages/api/src/context.test.ts`
- Modify: `packages/api/src/router/organization.ts`
- Modify: `packages/api/src/router/integrations.ts`
- Modify: `packages/api/src/services/customs.ts`
- Modify: `packages/api/src/services/usage.ts`
- Modify: `packages/db/src/usage.integration.test.ts`
- Modify: database integration tests that intentionally call public RPCs through Supabase JS

**Interfaces:**

- Produces: `loadSessionData(db, claims): Promise<{ memberships; profile; permissions }>` and `api.sso_provider_for_email(text)`, `api.sso_enforced_for_email(text)`.
- Preserves: `Context`, `ctx.rls`, Supabase Auth validation, Storage access, and current SSO result shapes.

- [ ] **Step 1: Write failing exposure and ACL tests**

Add tests asserting:

```ts
const { error: tableError } = await anon.from("organizations").select("id").limit(1);
expect(tableError?.code).toBe("PGRST106");

const { error: regulationError } = await anon.rpc("match_regulations", {
  query_embedding: zeroVector,
  match_count: 1,
  filter_jurisdiction: null,
});
expect(regulationError).toBeTruthy();

const { data: sso } = await anon.schema("api").rpc("sso_provider_for_email", {
  p_email: "owner@pathfinder.demo",
});
expect(sso).toBeTruthy();
```

The catalog test must require zero security definers with a non-empty search path and assert that
the anon-executable application function set equals the two SSO functions.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @corridor/db exec vitest run --project integration src/security-invariants.integration.test.ts`

Expected: `public` remains exposed, anon can execute regulation matching, and 24 definers fail the search-path assertion.

- [ ] **Step 3: Move PostgREST to the allowlisted API schema**

Set:

```toml
[api]
schemas = ["api", "graphql_public"]
extra_search_path = ["api", "public", "extensions"]
```

Create `api`, revoke its defaults, and add schema-qualified SSO wrapper functions with explicit
`anon, authenticated` execution grants. Revoke future automatic grants in exposed schemas.

- [ ] **Step 4: Rebuild function ACLs and search paths**

Recreate each application-owned definer using:

```sql
security definer
set search_path = ''
```

Schema-qualify every relation and called function. Revoke `execute` from `public, anon,
authenticated, service_role`, then grant only the caller set documented beside each function.
`match_regulations` receives `authenticated, service_role`; trigger helpers receive no direct app
grant. Replace broad table grants with the DML operations represented by each table's policies.

- [ ] **Step 5: Remove backend PostgREST business-table dependencies**

Implement session bootstrap through one `withRls` callback:

```ts
export async function loadSessionData(db: DatabaseClient, claims: RlsClaims) {
  return withRls(db, claims, async (tx) => {
    const memberships = await tx.select(/* existing shape */).from(organizationMembers);
    const [profile] = await tx
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, claims.sub));
    return { memberships, profile };
  });
}
```

Replace `ctx.supabase.rpc(...)` business calls with direct schema-qualified SQL inside `ctx.rls`.
Replace service-role Supabase RPC calls with `withServiceRole`. Keep `ctx.supabase` for Auth and
Storage only. Update the SSO browser helper to `.schema("api").rpc(...)`.

- [ ] **Step 6: Make system-authored writes trusted and idempotent**

Add `usage_records.source_event_id text` and:

```sql
create unique index usage_records_source_event_unique
  on public.usage_records (organization_id, metric, source_event_id)
  where source_event_id is not null;
```

Change `recordUsage` to require a deterministic source event ID and use `on conflict do nothing`.
Revoke authenticated execution of `record_usage`. Narrow authenticated writes on audit,
integration-event, compliance-alert, and notification data to existing supported API operations.

- [ ] **Step 7: Restart local services and verify GREEN**

Run: `pnpm exec supabase stop && pnpm exec supabase start && pnpm exec supabase db reset && pnpm db:seed`

Run the security, SSO, context, usage, Vault, and organization tests. Expected: business tables are
not available through PostgREST, SSO discovery remains available through `api`, and direct DB RLS
flows retain their behavior.

- [ ] **Step 8: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration`

Commit:

```bash
git add supabase/config.toml supabase/migrations/0032_database_api_hardening.sql apps/web/src/lib/sso* packages/api/src packages/db/src
git commit -m "fix(db): restrict database API privileges"
```

### Task 3: Make job claims idempotent and lease-token safe

**Files:**

- Create: `supabase/migrations/0033_job_delivery_hardening.sql`
- Modify: `packages/db/src/schema/integrations.ts`
- Modify: `packages/db/src/jobs.integration.test.ts`
- Modify: `packages/api/src/services/jobs.ts`
- Modify: `packages/api/src/jobs.integration.test.ts`
- Modify: `apps/web/src/app/api/jobs/process/route.ts`

**Interfaces:**

- Produces: `enqueueJob(..., { idempotencyKey })`, `claimNextJob(db, options)`, `renewJobLease(db, lease)`, and token-guarded completion/retry helpers.
- Changes: every claim returns `leaseToken`, `leaseExpiresAt`, and `heartbeatAt`; `processDueJobs` claims immediately before each execution.

- [ ] **Step 1: Write failing queue tests**

Add tests proving duplicate idempotency keys return one row, each claim has a unique lease token,
an obsolete token cannot complete a reclaimed job, heartbeat extends the lease, and the source
document sweep is safe under two concurrent invocations.

```ts
const staleFinish = await finishJob(db, { id: job.id, leaseToken: firstToken });
expect(staleFinish).toBe(false);
const currentFinish = await finishJob(db, { id: job.id, leaseToken: secondToken });
expect(currentFinish).toBe(true);
```

- [ ] **Step 2: Run focused queue tests and verify RED**

Run the DB and API jobs integration files. Expected: missing schema columns and missing token guards.

- [ ] **Step 3: Add job schema and claim function**

Add `idempotency_key`, `lease_token`, `lease_expires_at`, and `heartbeat_at`, plus partial unique,
running lease, and running organization indexes. Replace batch `claim_jobs` with a one-row atomic
claim returning a random lease token:

```sql
update public.background_jobs j
set status = 'running',
    attempts = attempts + 1,
    locked_by = p_worker,
    locked_at = now(),
    heartbeat_at = now(),
    lease_token = gen_random_uuid(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds)
where j.id = (select id from eligible_jobs for update skip locked limit 1)
returning j.*;
```

Completion and retry functions require `where id = p_id and lease_token = p_lease_token and
status = 'running'`.

- [ ] **Step 4: Implement worker loop and producer idempotency**

Make `processDueJobs` loop up to `limit`, claiming one job before each execution. Start a bounded
heartbeat timer during handler execution and always clear it. Supply deterministic keys at every
producer; make the extraction sweep an `insert ... select ... on conflict do nothing` operation.

- [ ] **Step 5: Add retention**

Add `purge_finished_jobs()` to delete succeeded/cancelled jobs older than 30 days and failed jobs
older than 90 days. Invoke it from the daily worker sweep and test that recent/active jobs remain.

- [ ] **Step 6: Verify and commit**

Reset/seed, run both jobs integration files, mirror verification, DB lint, typecheck, lint, and unit
tests. Commit:

```bash
git add supabase/migrations/0033_job_delivery_hardening.sql packages/db/src/schema/integrations.ts packages/db/src/jobs.integration.test.ts packages/api/src/services/jobs.ts packages/api/src/jobs.integration.test.ts apps/web/src/app/api/jobs/process/route.ts
git commit -m "fix(api): harden background job delivery"
```

### Task 4: Move every provider request outside transactions

**Files:**

- Modify: `packages/api/src/services/jobs.ts`
- Modify: `packages/api/src/services/customs.ts`
- Modify: `packages/api/src/services/notifications.ts`
- Modify: `packages/api/src/services/driver-notify.ts`
- Modify: `packages/api/src/services/documents.ts`
- Modify: `packages/api/src/services/copilot.ts`
- Modify: corresponding unit and integration tests in `packages/api/src/`

**Interfaces:**

- Produces: all `JobType` handlers with signature `(db: DatabaseClient, job: Job) => Promise<Result>`.
- Preserves: job payloads and user-visible customs/document/notification outcomes.

- [ ] **Step 1: Write failing transaction-boundary tests**

Instrument a provider mock so it executes `select txid_current_if_assigned()` through a separate
probe connection when called; assert it observes no transaction assigned to the handler's database
connection. Add state-version race tests proving a provider result cannot overwrite a movement or
document changed during the request.

- [ ] **Step 2: Verify RED**

Run the jobs, customs, documents, notification, and copilot service tests. Expected: current
transactional handlers call provider mocks before their wrapping transaction completes.

- [ ] **Step 3: Convert handlers to prepare/call/apply phases**

Use this concrete structure for customs and repeat it for document extraction, embeddings, driver
notifications, email, SMS, and push:

```ts
const prepared = await withServiceRole(db, (tx) => prepareCustomsDecision(tx, job));
if (prepared.skipped) return prepared;
const response = await prepared.client.fetchDecision(prepared.reference, prepared.manifest, {
  currentStatus: prepared.status,
});
return withServiceRole(db, (tx) => applyPreparedCustomsDecision(tx, prepared, response));
```

The apply function uses expected status/version predicates and records an explicit stale-result
outcome when zero rows match. Notification producers only insert durable job rows; delivery occurs
after commit.

- [ ] **Step 4: Configure role-scoped timeouts**

Add finite application defaults in the security migration or a follow-up migration:

```sql
alter role authenticated set statement_timeout = '30s';
alter role authenticated set lock_timeout = '5s';
alter role authenticated set idle_in_transaction_session_timeout = '15s';
```

Use scoped longer statement timeouts only for known reporting/worker SQL, never around HTTP calls.

- [ ] **Step 5: Verify and commit**

Run all affected unit and integration tests, then typecheck and lint. Commit:

```bash
git add packages/api/src supabase/migrations packages/db/src
git commit -m "fix(api): move provider calls outside transactions"
```

### Task 5: Align search operators and indexes

**Files:**

- Create: `supabase/migrations/0034_search_and_list_indexes.sql`
- Modify: `packages/db/src/schema/reference.ts`
- Modify: `packages/db/src/schema/registry.ts`
- Modify: `packages/db/src/schema/movements.ts`
- Modify: `packages/db/src/schema/inbond.ts`
- Modify: movement, shipment, party, reference, and in-bond routers/services and tests

**Interfaces:**

- Produces: `substringSearch(term)` normalized SQL helper and trigram-backed search paths.
- Preserves: case-insensitive substring behavior for three-or-more-character terms.

- [ ] **Step 1: Write failing query-shape tests**

Add unit assertions that two-character input uses exact/prefix matching and three-character input
uses the shared lower/coalesce substring expression. Add integration EXPLAIN tests on generated
fixtures requiring GIN bitmap/index plans with sequential scans disabled for the assertion.

- [ ] **Step 2: Verify RED**

Run focused router/service tests. Expected: no shared helper and no trigram indexes.

- [ ] **Step 3: Add and use trigram indexes**

Enable `pg_trgm`, create GIN indexes matching each exact expression, update every search query to
use the shared normalized expression, and drop only the five unused text-vector indexes identified
by the audit. Retain regulation/knowledge vector search.

- [ ] **Step 4: Add matching list/FK indexes and generated crossing time**

Add `(organization_id, updated_at desc, id desc)` or created-at equivalents for each list. Add
`crossing_at timestamptz generated always as (coalesce(scheduled_crossing_at, created_at)) stored`
and its organization/order index. Add all remaining child-side FK indexes and remove only the three
structurally redundant indexes named in the spec.

- [ ] **Step 5: Verify and commit**

Reset/seed, run search/reference/list integration tests, mirror verification, and DB lint. Commit:

```bash
git add supabase/migrations/0034_search_and_list_indexes.sql packages/db/src/schema packages/api/src
git commit -m "perf(db): align search and list indexes"
```

### Task 6: Replace OFFSET pagination with stable cursors

**Files:**

- Modify: `packages/domain/src/common.ts` and every domain list-input schema containing `offset`
- Create: `packages/api/src/pagination.ts`
- Create: `packages/api/src/pagination.test.ts`
- Modify: list routers/services under `packages/api/src/`
- Modify: list callers under `apps/web/` and `apps/mobile/`
- Modify: affected router, domain, web, and mobile tests

**Interfaces:**

- Produces: `encodeCursor({ timestamp, id }): string`, `decodeCursor(cursor): Cursor`, and list responses `{ items, nextCursor }`.
- Removes: unbounded page-number OFFSET execution from first-party list endpoints.

- [ ] **Step 1: Write failing cursor tests**

Test round-trip encoding, malformed cursor rejection, descending comparison, duplicate timestamps,
and page continuity after a concurrent insert:

```ts
expect(page1.items.map((x) => x.id)).not.toContain(page2.items[0]!.id);
expect([...page1.items, ...page2.items].map((x) => x.id)).toEqual(expectedStableOrder);
```

- [ ] **Step 2: Verify RED**

Run domain and pagination/router tests. Expected: list inputs or outputs lack the cursor contract.

- [ ] **Step 3: Implement the shared opaque cursor**

Encode versioned JSON as base64url and validate with Zod. Apply tuple predicates matching each
endpoint's complete order:

```ts
const before = cursor
  ? or(
      lt(table.updatedAt, cursor.timestamp),
      and(eq(table.updatedAt, cursor.timestamp), lt(table.id, cursor.id)),
    )
  : undefined;
```

Fetch `limit + 1`, remove the sentinel, and derive `nextCursor` from the final returned row.

- [ ] **Step 4: Convert every OFFSET endpoint and caller**

Convert movement, shipment, registry, documents, alerts, notifications, audit, imports, in-bond,
external shipments, PARS/RNS, integration events, and crossing reports. Update web page controls to
store a cursor stack for Previous and use `nextCursor` for Next. Update mobile one-page callers to
omit both offset and cursor.

- [ ] **Step 5: Verify and commit**

Run domain, API, web, and mobile tests plus typecheck and lint. Commit:

```bash
git add packages/domain/src packages/api/src apps/web apps/mobile
git commit -m "perf(api): replace offset lists with cursors"
```

### Task 7: Batch imports, usage updates, compliance, and registry writes

**Files:**

- Modify: `packages/api/src/services/imports.ts`
- Modify: `packages/api/src/services/imports.test.ts`
- Modify: `packages/db/src/imports.integration.test.ts`
- Modify: `packages/api/src/services/usage.ts`
- Modify: `packages/api/src/services/usage.test.ts`
- Modify: `packages/api/src/services/compliance.ts`
- Modify: compliance tests
- Modify: `packages/api/src/router/party.ts`
- Modify: registry tests

**Interfaces:**

- Produces: bounded multi-row statements of at most 500 input records and set-based provider-result updates.
- Preserves: atomic import behavior, per-row validation reporting, audit entries, and after-commit effects.

- [ ] **Step 1: Write failing statement-count tests**

Use the existing mock database recorder to commit 1,001 valid rows and assert at most three INSERT
statements for the target table plus one grouped line-number query. Add equivalent bounded statement
assertions for 500 usage outcomes and a multi-entity compliance scan.

- [ ] **Step 2: Verify RED**

Run focused import, usage, compliance, and party tests. Expected: statement counts grow linearly with
rows.

- [ ] **Step 3: Implement chunked/set-based writes**

Create a local `chunks<T>(rows, 500)` utility, call `.insert(...).values(chunk)` once per chunk, and
load commodity maximum line numbers with one grouped `where inArray(shipmentId, ids)` query. Update
usage records through one `update ... from (values ...)` statement. Prefetch compliance alerts once
per organization and write calculated changes in chunks. Use one registry status update with
`returning`, then batch audit rows.

- [ ] **Step 4: Verify and commit**

Run focused tests, full API unit tests, integration tests, typecheck, and lint. Commit:

```bash
git add packages/api/src packages/db/src/imports.integration.test.ts
git commit -m "perf(api): batch high-volume database writes"
```

### Task 8: Preaggregate crossing reports and strengthen schema verification

**Files:**

- Modify: `packages/api/src/services/crossings.ts`
- Modify: crossing/reporting tests
- Modify: `packages/db/scripts/verify-schema-mirror.ts`
- Modify: `packages/db/package.json` if a focused invariant script is added
- Modify: `docs/security-review.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Produces: one preaggregated crossing query and mirror checks for defaults, constraints, index definitions, and catalog security invariants.

- [ ] **Step 1: Write failing crossing and verifier tests**

Add a crossing fixture with multiple crew, trailers, seals, shipments, and commodities and assert
the result has no duplicated aggregates. Add verifier fixtures that deliberately change an index
predicate, FK action, default, and security-definer search path; each must produce a named drift
error.

- [ ] **Step 2: Verify RED**

Run focused tests. Expected: the verifier misses the deliberate drift and the query still contains
per-row correlated aggregates.

- [ ] **Step 3: Preaggregate the crossing report**

Replace scalar subqueries with CTEs grouped by movement ID and join each aggregate once. Filter and
order on `movements.crossingAt`, preserving the existing output schema and deterministic ID tie-break.

- [ ] **Step 4: Expand mirror/catalog verification**

Use `getTableConfig` plus `pg_catalog` to compare defaults, nullability, primary/unique/check/FK
constraints and actions, index method/order/expression/predicate/include/opclass. Add catalog checks
for RLS coverage, tenant composite FKs, FK indexes, definer search paths, anon-function allowlist,
and system-table authenticated policies.

- [ ] **Step 5: Update security and release documentation**

Record the backend-only Data API contract, composite tenant invariant, queue semantics, timeout
defaults, and rollback constraints in `docs/security-review.md` and `CHANGELOG.md`.

- [ ] **Step 6: Run final verification and commit**

Run:

```bash
pnpm exec supabase db reset
pnpm db:seed
pnpm --filter @corridor/db verify:mirror
pnpm db:lint
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm format:check
```

Inspect representative plans with `EXPLAIN (ANALYZE, BUFFERS)` for movement/shipments lists,
trigram search, queue claim, and crossing reports. Commit:

```bash
git add packages/api/src/services/crossings.ts packages/db/scripts/verify-schema-mirror.ts packages/db/package.json docs/security-review.md CHANGELOG.md
git commit -m "test(db): enforce database hardening invariants"
```

### Task 9: Whole-branch review and GitHub handoff

**Files:**

- Review: every file changed since the design commit
- Modify: only files required to resolve review findings

**Interfaces:**

- Produces: a clean, fully verified feature branch ready for explicit push authorization.

- [ ] **Step 1: Audit spec coverage**

Map every success criterion in the design spec to a passing test or catalog query. Re-run the two
original cross-tenant exploit sequences in rolled-back transactions and confirm FK rejection occurs
before the RLS read path can be established.

- [ ] **Step 2: Run complete verification from a clean reset**

Run the exact Task 8 command block and inspect full output. Treat warnings or skipped integration
tests as unresolved until explained and corrected.

- [ ] **Step 3: Inspect repository and remote state**

Run `git status --short`, `git diff --check`, `git log --oneline origin/main..HEAD`, and
`git diff --stat origin/main...HEAD`. Confirm no credentials, generated artifacts, or unrelated
user files are included.

- [ ] **Step 4: Present the branch for review**

Report commits, migration order, verification counts, known production rollout steps, and the exact
unpushed branch state. Push only after the user explicitly asks.
