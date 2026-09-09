# Avaal `pftrans` UI Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the local Pathfinder demo tenant with every supported company, registry, and ACE/ACI history record visibly available in the Avaal `pftrans` UI.

**Architecture:** An agentyc MCP client drives visible Chrome pages only and writes a private, ignored snapshot. Pure mapping code validates and transforms that snapshot into a typed import bundle; a separate database runner backs up the local stack, replaces the tenant atomically while preserving its UUID, provisions the owner through Supabase Auth, and verifies counts and relationships.

**Tech Stack:** TypeScript 5.9, Node.js 22, agentyc MCP over JSON-RPC stdio, Postgres 17 through `postgres`, Supabase Auth Admin API, Vitest 5, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-09-09-avaal-pftrans-ui-migration-design.md`

## Global Constraints

- Avaal is read-only and source extraction uses visible UI pages and controls only.
- Do not call Avaal APIs, hidden network endpoints, direct HTTP routes, database interfaces, or export downloads.
- Visit and account for every list row and detail page across all pagination pages.
- Do not change Corridor until the source snapshot is complete and validated.
- Replace all existing Pathfinder demo records while preserving the organization UUID.
- Never persist the Avaal/Corridor password, session cookies, tokens, or secret keys.
- Store snapshots, backups, and reports under `.local/avaal-import/`, with owner-only permissions and Git exclusion.
- Stop before mutation on any inaccessible category, inaccessible record, duplicate source ID, or unexplained count mismatch.
- Preserve exact displayed Avaal values in the private snapshot and report every unmappable value.
- Keep unrelated existing worktree changes untouched.

---

### Task 1: Private Snapshot Contract and Safety Guard

**Files:**

- Modify: `.gitignore`
- Create: `packages/db/src/avaal-import/snapshot.ts`
- Create: `packages/db/src/avaal-import/snapshot.test.ts`

**Interfaces:**

- Produces: `AVAAL_CATEGORIES`, `AvaalCategory`, `AvaalFieldValue`, `AvaalUiRecord`, `AvaalCategorySnapshot`, `AvaalSnapshot`, `validateSnapshot(value): AvaalSnapshot`, and `snapshotCounts(snapshot): Record<AvaalCategory, number>`.
- Consumes: Node standard library only.

- [ ] **Step 1: Add a failing contract test**

```ts
import { describe, expect, it } from "vitest";
import { snapshotCounts, validateSnapshot } from "./snapshot";

describe("Avaal UI snapshot", () => {
  it("accepts a completed UI category and counts unique records", () => {
    const snapshot = validateSnapshot({
      source: "avaal-ui",
      username: "pftrans",
      extractedAt: "2026-09-09T22:00:00.000Z",
      categories: {
        drivers: {
          route: "/Masters/Driver/Driver",
          displayedTotal: 1,
          finalPageReached: true,
          pagesVisited: [1],
          records: [
            {
              sourceId: "driver-1",
              sourceUrl: "/Masters/Driver/Driver/1",
              fields: { Name: "A Driver" },
            },
          ],
          warnings: [],
        },
      },
    });
    expect(snapshotCounts(snapshot).drivers).toBe(1);
  });

  it("rejects duplicate IDs, unfinished pagination, and displayed-count mismatches", () => {
    expect(() =>
      validateSnapshot({
        source: "avaal-ui",
        username: "pftrans",
        extractedAt: "2026-09-09T22:00:00.000Z",
        categories: {
          drivers: {
            route: "/Masters/Driver/Driver",
            displayedTotal: 2,
            finalPageReached: false,
            pagesVisited: [1],
            records: [
              { sourceId: "same", sourceUrl: "/one", fields: {} },
              { sourceId: "same", sourceUrl: "/two", fields: {} },
            ],
            warnings: [],
          },
        },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm the module is missing**

Run: `pnpm --filter @corridor/db exec vitest run --project unit src/avaal-import/snapshot.test.ts`

Expected: FAIL because `./snapshot` does not exist.

- [ ] **Step 3: Implement the snapshot contract without adding dependencies**

Define these exact category keys:

```ts
export const AVAAL_CATEGORIES = [
  "company",
  "users",
  "email_preferences",
  "drivers",
  "trucks",
  "trailers",
  "shippers",
  "consignees",
  "ace_manifests",
  "ace_shipments",
  "aci_trips",
  "aci_cargos",
  "external_shipments",
  "tcp",
  "pars_rns",
  "inbond",
] as const;
```

`validateSnapshot` must reject unknown top-level keys, empty `sourceId`/`sourceUrl`, duplicate IDs
within a category, `finalPageReached !== true`, non-contiguous positive page numbers, and any
non-null `displayedTotal` that differs from `records.length`. A category may be absent only when
its manifest explicitly marks it `notApplicable: true` with a non-empty reason.

Add `.local/avaal-import/` to `.gitignore` beneath the AI agent tooling section.

- [ ] **Step 4: Run the focused test**

Run: `pnpm --filter @corridor/db exec vitest run --project unit src/avaal-import/snapshot.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```bash
git add .gitignore packages/db/src/avaal-import/snapshot.ts packages/db/src/avaal-import/snapshot.test.ts
git commit -m "feat(db): define Avaal UI snapshot contract"
```

### Task 2: Agentyc MCP Client and UI Traversal Engine

**Files:**

- Create: `packages/db/src/avaal-import/agentyc-client.ts`
- Create: `packages/db/src/avaal-import/agentyc-client.test.ts`
- Create: `packages/db/src/avaal-import/ui-traversal.ts`
- Create: `packages/db/src/avaal-import/ui-traversal.test.ts`
- Create: `packages/db/scripts/avaal-ui-extract.ts`
- Modify: `packages/db/package.json`

**Interfaces:**

- Consumes: `AvaalCategory`, `AvaalCategorySnapshot`, and `validateSnapshot` from Task 1.
- Produces: `createAgentycClient(options): Promise<AgentycClient>`, `AgentycClient.call<T>(tool, args): Promise<T>`, `AgentycClient.close(): Promise<void>`, `traverseCategory(client, config): Promise<AvaalCategorySnapshot>`, and CLI script `pnpm --filter @corridor/db avaal:extract -- --cdp-url <ws-url> --output <directory>`.

- [ ] **Step 1: Write failing JSON-RPC framing tests**

Use an injected `Duplex` transport and assert that initialization sends protocol version
`2025-03-26`, tool-call IDs resolve only their matching promises, JSON-RPC errors reject, and tool
content with `isError: true` rejects with sanitized text. Assert that messages containing keys
matching `/password|cookie|token|secret/i` are redacted from errors.

- [ ] **Step 2: Run the client tests and confirm failure**

Run: `pnpm --filter @corridor/db exec vitest run --project unit src/avaal-import/agentyc-client.test.ts`

Expected: FAIL because the client module does not exist.

- [ ] **Step 3: Implement the minimal stdio MCP client**

Use `node:child_process.spawn` to run:

```ts
["mcp", "--cdp-url", options.cdpUrl, "--shared-browser-focus-policy", "activate"];
```

Send newline-delimited JSON-RPC, initialize once, send `notifications/initialized`, expose only the
agentyc tools used by the traversal (`browser_navigate`, `browser_get_state`, `browser_evaluate`,
`browser_click`, `browser_wait_for_stable_dom`, and `browser_wait_for_url`), and kill the child on
`close()`.

- [ ] **Step 4: Write failing traversal tests**

Create a fake `AgentycClient` response sequence covering two table pages, a disabled final Next
control, duplicate rows repeated across pages, and two detail pages. Assert that traversal visits
each unique source ID exactly once, rejects a duplicate with conflicting visible fields, and refuses
to mark completion until the disabled final control is observed.

- [ ] **Step 5: Run traversal tests and confirm failure**

Run: `pnpm --filter @corridor/db exec vitest run --project unit src/avaal-import/ui-traversal.test.ts`

Expected: FAIL because `traverseCategory` does not exist.

- [ ] **Step 6: Implement UI-only traversal**

`traverseCategory` must navigate through agentyc, read only visible table rows and visible form/detail
content, open each visible View/Edit/Details control without saving, return to the list, and click
the visible pagination control. DOM evaluation may read rendered text, labels, inputs, selects,
textareas, data attributes, and link targets; it must not call `fetch`, `XMLHttpRequest`, page
application functions, or inspect performance/network logs.

The extractor CLI must create its output with mode `0700`, write files with mode `0600`, checkpoint
only fully completed pages, resume from the last completed page, and call `validateSnapshot` before
writing `snapshot.json` and `manifest.json`.

- [ ] **Step 7: Add the package command**

Add:

```json
"avaal:extract": "tsx scripts/avaal-ui-extract.ts"
```

- [ ] **Step 8: Run focused tests and type checking**

Run:

```bash
pnpm --filter @corridor/db exec vitest run --project unit src/avaal-import/agentyc-client.test.ts src/avaal-import/ui-traversal.test.ts
pnpm --filter @corridor/db typecheck
```

Expected: both test files PASS and TypeScript exits 0.

- [ ] **Step 9: Commit the traversal engine**

```bash
git add packages/db/package.json packages/db/scripts/avaal-ui-extract.ts packages/db/src/avaal-import/agentyc-client.ts packages/db/src/avaal-import/agentyc-client.test.ts packages/db/src/avaal-import/ui-traversal.ts packages/db/src/avaal-import/ui-traversal.test.ts
git commit -m "feat(db): add UI-only Avaal extractor"
```

### Task 3: Inspect the Live Avaal UI and Configure Every Category

**Files:**

- Create: `packages/db/src/avaal-import/avaal-pages.ts`
- Create: `packages/db/src/avaal-import/avaal-pages.test.ts`
- Modify: `packages/db/scripts/avaal-ui-extract.ts`

**Interfaces:**

- Consumes: `traverseCategory` from Task 2.
- Produces: `AVAAL_PAGE_CONFIGS: Record<AvaalCategory, AvaalPageConfig>` with a route and verified visible selectors/labels for each category.

- [ ] **Step 1: Inspect each source page read-only in visible Chrome**

Through agentyc MCP, visit these exact routes and record only rendered UI structure:

```text
/Masters/Company/Company
/Masters/User/Users
/Masters/EmailPreferences/EmailPreferences
/Masters/Driver/Driver
/Masters/Truck/Truck
/Masters/Trailer/Trailer
/Masters/Location/Shipper
/Masters/Location/Consignee
/ACE/EManifest/Manifest
/ACE/Shipment/Shipment
/ACI/Trip/Trip
/ACI/Cargo/Cargo
/ACE/ExternalShipment/ExternalShipment
/ACI/Tcp/Tcp
/ACI/ParsRns/ParsRns
/Masters/InBondMonitor/InBondMonitor
```

For each route, identify the visible table, displayed total, page-size control, next-page control,
stable source ID, and visible read-only path to detail content. Do not trigger Add, Save, Delete,
Transmit, Amend, Cancel, or status-changing controls.

- [ ] **Step 2: Write failing configuration tests**

Assert all 16 `AVAAL_CATEGORIES` have exactly one config, all routes start with `/`, destructive
button labels are excluded, detail controls are limited to `View`, `Edit` opened read-only,
row-link navigation, or visible expand controls, and every paginated config declares a final-page
test.

- [ ] **Step 3: Run the configuration test and confirm failure**

Run: `pnpm --filter @corridor/db exec vitest run --project unit src/avaal-import/avaal-pages.test.ts`

Expected: FAIL until every inspected page is configured.

- [ ] **Step 4: Encode the observed UI configurations**

Add the inspected selectors and label rules to `AVAAL_PAGE_CONFIGS`. Store selectors and field
aliases only; never copy customer values into tracked fixtures or source files. Configure the CLI
to iterate the page map in dependency order: settings, users, masters, ACE, then ACI.

- [ ] **Step 5: Run configuration and traversal tests**

Run: `pnpm --filter @corridor/db exec vitest run --project unit src/avaal-import/avaal-pages.test.ts src/avaal-import/ui-traversal.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the page map**

```bash
git add packages/db/scripts/avaal-ui-extract.ts packages/db/src/avaal-import/avaal-pages.ts packages/db/src/avaal-import/avaal-pages.test.ts
git commit -m "feat(db): map Avaal UI pages for migration"
```

### Task 4: Snapshot-to-Corridor Mapping

**Files:**

- Create: `packages/db/src/avaal-import/mapping.ts`
- Create: `packages/db/src/avaal-import/mapping.test.ts`
- Create: `packages/db/src/avaal-import/status-mapping.ts`
- Create: `packages/db/src/avaal-import/status-mapping.test.ts`

**Interfaces:**

- Consumes: validated `AvaalSnapshot` from Task 1 and domain constants from `@corridor/domain`.
- Produces: `mapAvaalSnapshot(snapshot): CorridorImportBundle`, `mapMovementStatus(value)`, `mapShipmentStatus(value)`, and `MigrationException`.

Define `CorridorImportBundle` with sections for organization, carrier codes, users, notification
rules, drivers, driver documents, trucks, trailers, equipment plates, partners, movements,
movement crew, movement trailers, shipments, commodities, hazmat, seals, movement events, customs
submissions, PARS RNS events, external shipments, in-bond records, and in-bond events. References
between sections use deterministic source keys until database UUIDs are assigned.

- [ ] **Step 1: Write failing status and identity tests**

Cover at minimum these normalized statuses:

```ts
expect(mapMovementStatus("Released")).toBe("released");
expect(mapMovementStatus("On Hold")).toBe("held");
expect(mapMovementStatus("Rejected")).toBe("rejected");
expect(mapShipmentStatus("Arrived")).toBe("arrived");
expect(mapShipmentStatus("Entry on File")).toBe("entry_on_file");
```

Assert unknown statuses create a blocking `MigrationException` rather than defaulting to `draft`.
Assert shippers and consignees with the same normalized name/address merge into one `both` partner,
while distinct addresses remain distinct records.

- [ ] **Step 2: Run mapping tests and confirm failure**

Run: `pnpm --filter @corridor/db exec vitest run --project unit src/avaal-import/status-mapping.test.ts src/avaal-import/mapping.test.ts`

Expected: FAIL because mapping modules do not exist.

- [ ] **Step 3: Implement pure transformation functions**

Parse dates without applying the workstation timezone; convert weights only when a displayed unit
requires it; retain the original unit; normalize country and jurisdiction codes through existing
Corridor reference data; derive movement and shipment relationships only from visible Avaal IDs or
explicit visible control numbers. Never invent a port, carrier code, driver, equipment unit, or
partner.

Keep unmappable visible fields as exceptions containing category, source ID, field label, displayed
value, and reason. Mark missing required target values as blocking; optional unsupported fields are
non-blocking but remain in the private snapshot and report.

- [ ] **Step 4: Run mapping tests and type checking**

Run:

```bash
pnpm --filter @corridor/db exec vitest run --project unit src/avaal-import/status-mapping.test.ts src/avaal-import/mapping.test.ts
pnpm --filter @corridor/db typecheck
```

Expected: PASS and exit 0.

- [ ] **Step 5: Commit mapping logic**

```bash
git add packages/db/src/avaal-import/mapping.ts packages/db/src/avaal-import/mapping.test.ts packages/db/src/avaal-import/status-mapping.ts packages/db/src/avaal-import/status-mapping.test.ts
git commit -m "feat(db): map Avaal records to Corridor"
```

### Task 5: Atomic Tenant Replacement and Auth Provisioning

**Files:**

- Create: `packages/db/src/avaal-import/apply.ts`
- Create: `packages/db/src/avaal-import/apply.integration.test.ts`
- Create: `packages/db/src/avaal-import/auth.ts`
- Create: `packages/db/src/avaal-import/auth.test.ts`
- Create: `packages/db/scripts/avaal-ui-apply.ts`
- Modify: `packages/db/package.json`

**Interfaces:**

- Consumes: `CorridorImportBundle` from Task 4, `DIRECT_DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`.
- Produces: `replaceTenant(sql, orgId, bundle, ownerUserId): Promise<ApplyReport>`, `ensureOwner(admin, input): Promise<AuthUserResult>`, `removeDemoUsers(admin, ids): Promise<void>`, and CLI `pnpm --filter @corridor/db avaal:apply -- --snapshot <path> --password-stdin`.

- [ ] **Step 1: Write a failing integration test for rollback and replacement**

Seed an isolated test organization, add a member and one movement, call `replaceTenant` with an
invalid child reference, and assert the original rows remain. Then call it with a valid minimal ACE
and ACI bundle and assert the same organization UUID now owns only the imported rows and no seed
row remains.

- [ ] **Step 2: Run the integration test and confirm failure**

Run: `pnpm --filter @corridor/db exec vitest run --project integration src/avaal-import/apply.integration.test.ts`

Expected: FAIL because `replaceTenant` does not exist.

- [ ] **Step 3: Implement transactional replacement**

Inside one `postgres.begin` callback:

1. lock the target organization with `select ... for update`;
2. verify its name is Pathfinder Trans Inc;
3. delete the organization row;
4. reinsert the mapped organization using the same UUID;
5. recreate tenant-scoped roles and copy system role permissions;
6. insert the owner membership;
7. insert carrier codes and master registries;
8. resolve deterministic source keys to UUIDs;
9. insert movements and their children;
10. insert shipments and their children;
11. insert status/customs/in-bond history; and
12. return per-table counts before commit.

All values must use parameterized `postgres` tagged templates. Do not use concatenated SQL values.

- [ ] **Step 4: Write failing Auth helper tests**

Mock the Supabase Admin client. Assert `ensureOwner` reuses a matching e-mail, creates a confirmed
user when absent, stores only `display_name` metadata, and never includes the password in returned
reports or thrown errors. Assert demo users are deleted only when every supplied ID ends in a
successful Admin API response.

- [ ] **Step 5: Implement Auth helpers and apply CLI**

Read the owner password from stdin when `--password-stdin` is supplied, keep it in a local variable
only until `ensureOwner` returns, and do not print it. Validate the snapshot, run the pure mapper,
refuse to apply when any blocking exception exists, and print a redacted dry-run summary unless
`--confirm-replace-pathfinder` is supplied.

Add:

```json
"avaal:apply": "tsx scripts/avaal-ui-apply.ts"
```

- [ ] **Step 6: Run unit and integration tests**

Run:

```bash
pnpm --filter @corridor/db exec vitest run --project unit src/avaal-import/auth.test.ts
pnpm --filter @corridor/db exec vitest run --project integration src/avaal-import/apply.integration.test.ts
pnpm --filter @corridor/db typecheck
```

Expected: PASS and exit 0.

- [ ] **Step 7: Commit replacement code**

```bash
git add packages/db/package.json packages/db/scripts/avaal-ui-apply.ts packages/db/src/avaal-import/apply.ts packages/db/src/avaal-import/apply.integration.test.ts packages/db/src/avaal-import/auth.ts packages/db/src/avaal-import/auth.test.ts
git commit -m "feat(db): add atomic Avaal tenant replacement"
```

### Task 6: Backup and Verification Runner

**Files:**

- Create: `packages/db/src/avaal-import/verify.ts`
- Create: `packages/db/src/avaal-import/verify.test.ts`
- Create: `packages/db/scripts/avaal-ui-verify.ts`
- Modify: `packages/db/package.json`

**Interfaces:**

- Consumes: `AvaalSnapshot`, `CorridorImportBundle`, and `ApplyReport`.
- Produces: `verifyImportedTenant(sql, orgId, snapshot, bundle): Promise<VerificationReport>` and CLI `pnpm --filter @corridor/db avaal:verify -- --snapshot <path>`.

- [ ] **Step 1: Write failing verification tests**

Assert the verifier reports category count mismatches, duplicate control numbers, missing movement
parents, cross-tenant references, missing crew/equipment/partner references, and demo e-mail
memberships. Assert a complete minimal ACE/ACI fixture returns zero failures.

- [ ] **Step 2: Run the test and confirm failure**

Run: `pnpm --filter @corridor/db exec vitest run --project unit src/avaal-import/verify.test.ts`

Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Implement verification and reporting**

The report must include extracted, mapped, inserted, skipped, warning, and failure counts per
category; orphan query results; representative source/target field comparisons; owner membership;
and any unmapped fields. Exit non-zero for any count mismatch, orphan, demo membership, missing
owner, or blocking exception.

Add:

```json
"avaal:verify": "tsx scripts/avaal-ui-verify.ts"
```

- [ ] **Step 4: Run focused tests and all DB unit tests**

Run:

```bash
pnpm --filter @corridor/db exec vitest run --project unit src/avaal-import/verify.test.ts
pnpm --filter @corridor/db test
pnpm --filter @corridor/db typecheck
pnpm --filter @corridor/db lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the verifier**

```bash
git add packages/db/package.json packages/db/scripts/avaal-ui-verify.ts packages/db/src/avaal-import/verify.ts packages/db/src/avaal-import/verify.test.ts
git commit -m "feat(db): verify Avaal migration completeness"
```

### Task 7: Extract and Validate the Complete Avaal Snapshot

**Files:**

- Create, ignored and private: `.local/avaal-import/pftrans-<UTC timestamp>/snapshot.json`
- Create, ignored and private: `.local/avaal-import/pftrans-<UTC timestamp>/manifest.json`
- Create, ignored and private: `.local/avaal-import/pftrans-<UTC timestamp>/exceptions.json`

**Interfaces:**

- Consumes: the visible agentyc-controlled Chrome session authenticated as Avaal `pftrans`.
- Produces: a validated private source snapshot accepted by `validateSnapshot` and `mapAvaalSnapshot`.

- [ ] **Step 1: Confirm the visible source identity**

Use agentyc UI state to confirm the dashboard displays `PATHFINDER TRANS INC.`, user `RANVINDER S
SARWARA`, role `Customer Admin`, and the `/Masters/User/Dashboard` path. Stop if any value differs.

- [ ] **Step 2: Run the full UI-only extractor**

Run the extractor with the current visible Chrome CDP URL and a new timestamped private output
directory. Monitor page checkpoints, reauthenticate through visible UI if the session expires, and
fix only selector or traversal defects proven by the current rendered UI.

- [ ] **Step 3: Validate page coverage and source counts**

Run the snapshot validator and mapper in dry-run mode. For every category, compare unique snapshot
records to the Avaal count displayed in the UI. Revisit any category with a mismatch; do not weaken
the validator to accept unexplained differences.

- [ ] **Step 4: Inspect blocking and non-blocking exceptions**

Resolve mapping defects when the visible value has a valid Corridor representation. Stop before
replacement if any record is inaccessible or any required target field remains absent. Keep
optional unsupported fields in `exceptions.json`.

- [ ] **Step 5: Record the validated snapshot hash**

Run `sha256sum` on `snapshot.json`, store the hash in `manifest.json`, and confirm `git status
--short` does not list `.local/avaal-import/`.

### Task 8: Backup, Replace, and Prove the Migrated Tenant

**Files:**

- Create, ignored and private: `.local/avaal-import/backups/corridor-before-pftrans-<UTC timestamp>.dump`
- Create, ignored and private: `.local/avaal-import/pftrans-<UTC timestamp>/migration-report.json`

**Interfaces:**

- Consumes: validated snapshot from Task 7 and the supplied owner password through stdin.
- Produces: replaced Pathfinder tenant, `pftransinc@gmail.com` Owner account, verified migration report, and recoverable pre-migration backup.

- [ ] **Step 1: Create and inspect the backup**

Run `pg_dump -Fc` against the local Corridor database into the private backup path, set mode `0600`,
then run `pg_restore --list` against it. Stop if either command fails or the archive has no entries.

- [ ] **Step 2: Run a redacted dry run**

Run `avaal:apply` without `--confirm-replace-pathfinder`. Confirm the displayed per-category counts
match the validated snapshot and the command reports no blocking exceptions.

- [ ] **Step 3: Apply the replacement**

Pipe the supplied password to `avaal:apply --password-stdin --confirm-replace-pathfinder` without
shell echo or command-line exposure. Retain the five demo Auth users until database and owner
verification both pass.

- [ ] **Step 4: Run database verification**

Run `avaal:verify` against the exact snapshot hash applied. Require zero failures, zero orphans,
zero demo memberships, and matching counts for every source category that maps to Corridor.

- [ ] **Step 5: Verify through the Corridor UI**

Sign in as `pftransinc@gmail.com` and confirm the company profile, carrier codes, users, drivers,
trucks, trailers, partners, ACE movements/shipments, and ACI movements/shipments render. Open at
least one record for every status observed in Avaal and compare identifiers, dates, partners,
equipment, crew, and line items.

- [ ] **Step 6: Remove obsolete demo Auth users**

After Steps 4 and 5 pass, delete only the recorded Auth IDs for the five `@pathfinder.demo` users.
Rerun verification and require zero demo Auth users and zero demo memberships.

- [ ] **Step 7: Run repository verification**

Run:

```bash
pnpm --filter @corridor/db test
pnpm --filter @corridor/db test:integration
pnpm --filter @corridor/db typecheck
pnpm --filter @corridor/db lint
pnpm typecheck
pnpm lint
pnpm test
```

Expected: every command exits 0.

- [ ] **Step 8: Produce the final report**

Write `migration-report.json` with the source snapshot hash, backup path, organization UUID,
administrator e-mail, per-category extracted/mapped/imported/skipped counts, exception list,
verification results, and completion timestamp. Do not include credentials, tokens, cookies, or
secret keys.
