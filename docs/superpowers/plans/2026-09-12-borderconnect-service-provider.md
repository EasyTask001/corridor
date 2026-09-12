# BorderConnect Service-Provider Customs Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. UI tasks (13, 14) must invoke the `ui-ux-pro-max` skill before touching components. Use `contextro` (`search`, `refactor_check`) before editing shared symbols.

**Goal:** File and track ACE (CBP) and ACI (CBSA) e-manifests for every Corridor tenant through BorderConnect's eManifest API in Service Provider mode — one EasyTask API key, one `companyKey` per carrier organization — with a durable shared inbox, RNS/PARS release tracking, a ready-to-cross readiness rollup, and a (hosting-deferred) WebSocket listener.

**Architecture:** A third `CustomsClient` mode `border_connect` under `packages/integrations/src/customs/borderconnect/` (transport, ACE/ACI mappers validated against BorderConnect's vendored JSON Schemas, inbound message parser) plugs into the existing `createCustomsClient` / `customsClientFor` seam. Outbound filings go straight through `transmitMovement` / `transmitAmendment` / `cancelAtCustoms` unchanged. Inbound never goes through per-movement polling: a global `customs.borderconnect_drain` job (cron, every minute) GETs the shared queue, persists every message in a new `customs_inbox` table first, then routes each row by `companyKey → organizations.border_connect_company_key` and by `tripNumber / control number → customs_submissions / shipments`, and applies it through the existing `applyStatusMessage`. `organizations.border_connect_company_key` is a column (extend-before-add); enable/disable per regime is the existing `integration_configs` row per provider.

**Tech Stack:** TypeScript, Drizzle + Supabase Postgres (RLS), tRPC, Next.js (Vercel cron), Vitest, `ajv` (schema validation in tests only), `ws` (listener app), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-borderconnect-customs-adapter-design.md` — rewritten in Task 1 to this design (Service Provider mode, inbox table, confirmed operation semantics). The pasted proposal in the planning conversation and the three explorer reports are the sources.

## Context

Corridor already ships `mock` and a generic `gateway` customs client (0023). EasyTask's BorderConnect account is credentialed (`.env.local`: `BORDERCONNECT_API_KEY=a-33724-…`, `BORDERCONNECT_API_WEBSOCKET_URL=wss://borderconnect.com/api/sockets/<suffix>`), is a **Service Provider** account, and has a test carrier `companyKey`. The 2026-09-10 spec was approved but never implemented and made single-carrier mode a goal and Service Provider mode a non-goal; that is now reversed. BorderConnect's protocol (confirmed from the live docs + 25 PDF manuals + JSON schemas during planning) is message-oriented: `POST /api/send/{suffix}` and `GET /api/receive/{suffix}` with an `Api-Key` header; `companyKey` on every outbound message and echoed on every inbound type; `sendId` echoed only on `API_RESPONSE`; ACE status arrives inside `ACE_RESPONSE` (`processingResponse` | `validationResponses` | `tripStatus` | `shipmentStatusList`); ACI as `ACI_RESPONSE` (`ACCEPT|REJECT`) + `ACI_NOTICE`; RNS as `RNS_SHIPMENT`; service alerts as `SYSTEM_ALERT`. `operation: UPDATE|DELETE` + `autoSend:true` are confirmed for trips already on file. **The `GET /api/receive` success envelope is undocumented** and is settled by the live smoke script (Task 16) — the transport normalises defensively until then.

## Global Constraints

- Repo rules in `CLAUDE.md` / `CONTRIBUTING.md`: extend before add; every `create table` carries a "Why a new table" paragraph (model: `supabase/migrations/0028_import_batches.sql:12-20`); tenant tables have `organization_id … on delete cascade`, RLS via `has_permission()` / `is_org_member()`, a cross-tenant integration test; migrations are never edited once applied; Drizzle mirror in `packages/db/src/schema/`; verification `pnpm typecheck && pnpm lint && pnpm test`, plus `source .env.local && pnpm exec supabase db reset && pnpm db:seed`, `pnpm --filter @corridor/db verify:mirror`, `pnpm db:lint`, `pnpm test:integration` for SQL/API changes.
- Every external service degrades to a deterministic fixture when its env var is unset: `border_connect` mode with no `BORDERCONNECT_API_KEY` replays fixtures. Tests pass with no credentials.
- No compliance mismapping: where BorderConnect needs a field Corridor does not hold, the mapper throws `CustomsTransportError(message, 422, false)` listing every missing field. Never approximate, never drop silently.
- Inbound messages are persisted before they are interpreted; nothing BorderConnect hands out is ever discarded (unroutable rows stay in `customs_inbox` with `processing_error`).
- Service-role code paths are enumerated in `docs/security-review.md` §8; every new one is added there.
- Conventional commits, one concern per commit, never push. CI is disabled — verify locally.
- Local Supabase on the 553xx port range; main checkout's dev server squats :3000 — run Playwright against a worktree server via `PLAYWRIGHT_BASE_URL` on :3100. Main and the `avaal-parity` worktree share Postgres :55322 — a `db reset` here changes the other's schema.
- New env: `BORDERCONNECT_API_URL_SUFFIX` (the `[suffix]` in the WebSocket URL already in `.env.local`), `BORDERCONNECT_API_KEY` (exists), `BORDERCONNECT_TEST_COMPANY_KEY` (smoke only). `BORDERCONNECT_API_WEBSOCKET_URL` is dropped — the socket URL is derived from the suffix.

## File Structure

```
packages/integrations/src/customs/borderconnect/
  transport.ts        HTTP send/receive (Api-Key), FAILURE parsing, receive normalisation; fixture transport
  ace.ts              ManifestPayload → ACE_TRIP (+ nested ACE_SHIPMENT)
  aci.ts              ManifestPayload → ACI_TRIP (+ nested ACI_SHIPMENT)
  send-request.ts     ACE_SEND_REQUEST / ACI_SEND_REQUEST builders (cancel)
  validate.ts         mandatory-field / regex / code-list checks → CustomsTransportError 422
  inbound.ts          BorderConnect inbound JSON → BorderConnectInbound union → CustomsStatusMessage
  client.ts           createBorderConnectCustomsClient(): CustomsClient
  format.ts           tripNumberFor(), bcDateTime(), port padding, plate helpers
  code-lists.ts       vendored small lists (truck types, packaging units, ACE/ACI shipment-type maps)
  schemas/*.json      vendored BorderConnect JSON Schemas (tests only)
  fixtures/*.json     canned inbound messages for offline replay
  README.md
packages/integrations/src/customs/types.ts        CustomsClientMode + ManifestPayload extension
packages/integrations/src/customs/manifest.ts     buildManifest extension
packages/integrations/src/customs/index.ts        border_connect branch + exports
packages/domain/src/customs-events.ts             new event codes
packages/domain/src/readiness.ts                  crossingReadiness()
packages/db/src/schema/{core,integrations,registry}.ts   mirror of 0047
supabase/migrations/0047_borderconnect.sql
packages/api/src/services/customs.ts              customsClientFor / scheduleDecision / applyStatusMessage events-only
packages/api/src/services/movements.ts            recordCustomsEvents() extraction
packages/api/src/services/borderconnect.ts        inbox drain: store, route, apply, RNS, alerts
packages/api/src/services/jobs.ts                 customs.borderconnect_drain
packages/api/src/router/{integrations,organization,movement}.ts
apps/web/src/app/api/jobs/borderconnect-drain/route.ts + apps/web/vercel.json
apps/web/src/app/(app)/settings/{integrations,organization}/…
apps/web/src/components/movement/readiness-panel.tsx (+ workspace, movements-table badge)
apps/borderconnect-listener/                       WebSocket → customs_inbox (Dockerfile, no deploy config)
scripts/borderconnect-smoke.ts                     live autoSend:false round-trip
```

---

### Task 1: Rewrite the spec to the Service-Provider design and save this plan

**Files:**
- Modify: `docs/superpowers/specs/2026-09-10-borderconnect-customs-adapter-design.md`
- Create: `docs/superpowers/plans/2026-09-12-borderconnect-service-provider.md` (copy of this plan)

- [ ] **Step 1: Rewrite the spec.** Keep the "Why" transport bullets, error codes, fixture-replay and testing sections. Replace: Status line → `Status: superseded 2026-09-12 — Service Provider mode, shared inbox; implemented by docs/superpowers/plans/2026-09-12-borderconnect-service-provider.md`. Non-goals: remove the Service-provider bullet and replace with "Carrier-key (non-SP) mode: not built; `companyKey` is always sent". Remove the `store.ts` / `pending_inbound` section and the "per-movement poll loop kept" non-goal; add sections **Service Provider identity** (`organizations.border_connect_company_key`; EasyTask suffix/key from env; `companyKey` on trip + every nested shipment + send requests), **Shared inbox** (`customs_inbox` grain, drain job, routing keys: `companyKey` → org; `sendId` → `customs_submissions.correlation_id`; `tripNumber` → `customs_submissions.reference_number`; `cargoControlNumber`/`shipmentControlNumber` → `shipments.control_number`; unroutable kept), **Confirmed protocol facts** (operation UPDATE/DELETE + autoSend rules verbatim from the ACE/ACI PDFs; ACE status inside `ACE_RESPONSE`; `sendId` only on `API_RESPONSE`; `GET receive` shape unconfirmed → smoke script), **Amend/cancel** (amend = full re-upload `operation: UPDATE, autoSend: true`; cancel = `ACE_SEND_REQUEST CANCEL_TRIP_AND_SHIPMENTS` / `ACI_SEND_REQUEST CANCEL, bundleTripAndShipments: true`), **RNS / SYSTEM_ALERT**, **Readiness**, **WebSocket listener (hosting deferred)**, and an updated **Open risks** list: receive envelope; ACI amendment reason codes with autoSend UPDATE; `time-zones.json` values; ACE hazmat `emergencyContact` and in-bond `irsNumber`/`fda` not captured (422 in v1); `companyKey` length (30 documented vs 32-char sample — do not hard-validate); `"FAILED"` vs `"FAILURE"`; whether an open WebSocket diverts messages from the HTTP queue.
- [ ] **Step 2: Copy this plan** to `docs/superpowers/plans/2026-09-12-borderconnect-service-provider.md`.
- [ ] **Step 3: Commit** `docs(customs): supersede the BorderConnect spec with the service-provider design and plan`.

---

### Task 2: Migration 0047 — mode widening, company key, truck type, `customs_inbox`, job policy

**Files:**
- Create: `supabase/migrations/0047_borderconnect.sql`
- Modify: `packages/db/src/schema/integrations.ts:48,175` (mode enums; add `customsInbox`), `packages/db/src/schema/core.ts` (organizations: `borderConnectCompanyKey`), `packages/db/src/schema/registry.ts` (trucks: `truckType`)
- Test: `packages/db/src/borderconnect.integration.test.ts`

**Interfaces:**
- Produces: `schema.customsInbox` (Drizzle table), `organizations.borderConnectCompanyKey: text | null`, `trucks.truckType: text` (default `'TR'`), mode enum `["mock","gateway","border_connect"]` on `integrationConfigs` and `customsSubmissions`; job type `customs.borderconnect_drain` allowed only for the service role.

- [ ] **Step 1: Write the failing integration tests** (pattern: `packages/db/src/customs.integration.test.ts`, `rls.integration.test.ts` — `actorFor("owner@pathfinder.demo")`, `withRls`, `expectRlsDenied`, `withServiceRole`):

```ts
describe("0047 borderconnect", () => {
  it("accepts mode = border_connect on integration_configs and customs_submissions", ...); // insert as owner, expect rows
  it("rejects two organizations with the same border_connect_company_key", ...);          // service role, expect unique violation
  it("defaults trucks.truck_type to TR and rejects a non two-letter code", ...);
  it("customs_inbox: service role inserts, org A owner reads only rows routed to A, org B sees zero, authenticated insert is denied", ...);
  it("customs_inbox: rows with organization_id null are invisible to every tenant", ...);
  it("background_jobs: authenticated cannot enqueue customs.borderconnect_drain, service role can with organization_id null", ...);
});
```

- [ ] **Step 2: Run** `source .env.local && pnpm --filter @corridor/db test:integration -- borderconnect` → FAIL (relations/columns missing).
- [ ] **Step 3: Write the migration:**

```sql
-- 0047 BorderConnect service-provider mode
-- 1. integration_configs / customs_submissions (same grain — widen the check)
alter table public.integration_configs drop constraint integration_configs_mode_check,
  add constraint integration_configs_mode_check check (mode in ('mock','gateway','border_connect'));
alter table public.customs_submissions drop constraint customs_submissions_mode_check,
  add constraint customs_submissions_mode_check check (mode in ('mock','gateway','border_connect'));

-- 2. organizations (one-to-one with scac_code / canadian_carrier_code → column)
alter table public.organizations
  add column border_connect_company_key text
    check (char_length(border_connect_company_key) between 1 and 64);
create unique index organizations_border_connect_company_key_key
  on public.organizations (border_connect_company_key)
  where border_connect_company_key is not null;   -- query: inbox routing by companyKey

-- 3. trucks (same grain — column): BorderConnect/CBP conveyance type, truck-types.json
alter table public.trucks
  add column truck_type text not null default 'TR' check (truck_type ~ '^[A-Z]{2}$');

-- 4. customs_inbox
-- Why a new table: the grain is one inbound message from a provider's SHARED
-- queue, received before its tenant is known. integration_events was
-- considered: organization_id is not null there, its grain is one HTTP call,
-- and it is append-only — an unroutable message has no organization yet and a
-- row here is updated when it is processed. customs_submissions was considered:
-- one row per outbound filing; a filing receives many messages and some
-- messages (SYSTEM_ALERT, RNS_SHIPMENT) belong to no filing. background_jobs
-- was considered: a job is a unit of work, not a record that must survive it.
create table public.customs_inbox (
  id                       bigint generated always as identity primary key,
  organization_id          uuid references public.organizations(id) on delete cascade,
  provider                 text not null default 'border_connect' check (provider in ('border_connect')),
  company_key              text,
  data_type                text not null,
  send_id                  text,
  trip_number              text,
  cargo_control_number     text,
  shipment_control_number  text,
  payload                  jsonb not null,
  payload_sha256           text not null unique,        -- dedup: HTTP retries / socket + poll overlap
  received_at              timestamptz not null default now(),
  processed_at             timestamptz,
  processing_error         text,
  movement_id              uuid,
  customs_submission_id    uuid,
  constraint customs_inbox_movement_org_fkey foreign key (movement_id, organization_id)
    references public.movements(id, organization_id) on delete set null,
  constraint customs_inbox_submission_org_fkey foreign key (customs_submission_id, organization_id)
    references public.customs_submissions(id, organization_id) on delete set null
);
create index customs_inbox_unprocessed_idx on public.customs_inbox (id) where processed_at is null; -- drain
create index customs_inbox_org_received_idx on public.customs_inbox (organization_id, received_at desc)
  where organization_id is not null;                                                              -- settings page list
alter table public.customs_inbox enable row level security;
create policy customs_inbox_select on public.customs_inbox for select to authenticated
  using (organization_id is not null and public.has_permission(organization_id, 'integrations.manage'));
revoke all on public.customs_inbox from anon, authenticated;
grant select on public.customs_inbox to authenticated;
grant all on public.customs_inbox to service_role;

-- 5. background_jobs_insert — live definition is 0025. Rebuilt with
-- customs.borderconnect_drain, enqueued only by the cron route under the service role.
drop policy background_jobs_insert on public.background_jobs;
create policy background_jobs_insert on public.background_jobs for insert to authenticated
  with check (
    organization_id is not null and case job_type
      when 'customs.decide' then public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'customs.poll_status' then public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'customs.notices_sync' then false
      when 'customs.borderconnect_drain' then false
      when 'driver.notify' then public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'compliance.scan' then public.has_permission(organization_id, 'alert.manage')
      when 'document.extract' then public.has_permission(organization_id, 'document.upload')
      when 'copilot.embed_knowledge' then case payload ->> 'sourceType'
        when 'movement_note' then public.has_permission(organization_id, 'movement.write')
        when 'hold_resolution' then public.has_permission(organization_id, 'alert.manage')
        when 'sop_document' then public.has_permission(organization_id, 'document.upload')
        else false end
      when 'notification.push' then public.is_org_member(organization_id)
      else false
    end
  );
```

(Verify the composite parent keys `movements(id, organization_id)` and `customs_submissions_id_organization_unique` exist — 0031 added both — before relying on the composite FKs.) Also add `(trip_number)` and `(cargo_control_number)` indexes with a comment naming the Settings inbox search, and bump the migration range in the `packages/db/src/schema/index.ts` header comment to 0047.

- [ ] **Step 4: Mirror in Drizzle.** `integrations.ts`: both `mode` enums → `["mock", "gateway", "border_connect"]`; add `export const customsInbox = pgTable("customs_inbox", {...})` with the columns, partial indexes and composite FKs above (use `foreignKey({...}).onDelete("set null")` like `customsSubmissions`). `core.ts`: `borderConnectCompanyKey: text("border_connect_company_key")` + the partial unique index. `registry.ts`: `truckType: text("truck_type").notNull().default("TR")`.
- [ ] **Step 5: Run** `source .env.local && pnpm exec supabase db reset && pnpm db:seed && pnpm --filter @corridor/db verify:mirror && pnpm db:lint && pnpm --filter @corridor/db test:integration` → PASS. Then `pnpm typecheck` (new nullable/defaulted columns should not break callers; fix any `trucks` insert fixtures that spread full rows).
- [ ] **Step 6: Commit** `feat(db): 0047 BorderConnect mode, company key, truck type and the shared customs inbox`.

---

### Task 3: Extend the provider-neutral `ManifestPayload`

**Files:**
- Modify: `packages/integrations/src/customs/types.ts:10-114`, `packages/integrations/src/customs/manifest.ts`, `packages/api/src/services/customs.ts:243-308` (`manifestFor`), `packages/api/src/services/movements.ts:526-540` (crew projection into `FullMovement` if `dateOfBirth` is not already passed through — `crewForMovement` selects it at L420)
- Test: `packages/integrations/src/customs/manifest.test.ts` (new)

**Interfaces (Produces):**
```ts
interface ManifestParty { name: string; address: string | null;
  postal: { line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null; country: string | null } | null; }
ManifestPayload.carrier += { scac: string | null; canadianCarrierCode: string | null; timezone: string }
ManifestPayload.crew[i] += { dateOfBirth: string | null }          // ISO date
ManifestPayload.conveyance += { truckType: string }                // 'TR' default
ManifestPayload.shipments[i] += { loading: { country: string | null; province: string | null; city: string | null };
                                  delivery: ManifestParty["postal"] }
ManifestPayload.shipments[i].commodities[j] += { packagingType: string | null; weightUnit: "KG" | "LB" | null }
ManifestSource mirrors each (organization.scacCode/canadianCarrierCode/timezone; crew.dateOfBirth; truck.truckType; shipments.loadingCountry/loadingProvince/loadingCity/deliveryAddress; commodities.packagingType/weightUnit)
```

- [ ] **Step 1: Write `manifest.test.ts`** with a minimal valid `ManifestSource` fixture (`makeSource()` helper) and tests: `carries carrier scac, canadian code and timezone`; `carries crew dateOfBirth`; `carries truckType`; `carries shipment loading place and structured party postal address`; `carries commodity packagingType and weightUnit`; and keeps the six existing preconditions (person in charge, truck, port, carrier code, ETA, shipments vs isEmpty).
- [ ] **Step 2: Run** `pnpm --filter @corridor/integrations test -- manifest` → FAIL (type errors / missing fields).
- [ ] **Step 3: Implement.** In `types.ts` add the fields above. In `manifest.ts` extend `ManifestSource`, keep `formatAddress`, and make `party()` return `{ name, address: formatAddress(a), postal: a ? { line1: a.line1 ?? null, line2: a.line2 ?? null, city: a.city ?? null, region: a.region ?? null, postalCode: a.postalCode ?? null, country: a.country ?? null } : null }`. In `manifestFor` pass `org.scacCode`, `org.canadianCarrierCode`, `org.timezone`, `c.dateOfBirth`, `full.truck.truckType`, `s.loadingCountry/loadingProvince/loadingCity`, `s.deliveryAddress`, `c.packagingType`, `c.weightUnit`. `dateOfBirth` from the DB is a `date` column — pass as `YYYY-MM-DD` string (Drizzle `date` mode string) or `toISOString().slice(0,10)`.
- [ ] **Step 4: Fix the ripple:** `pnpm typecheck` — the mock client, gateway mapping tests and `packages/api/src/services/customs.test.ts` build `ManifestPayload`s; add the new fields to their fixtures (do not change gateway wire output: `toGatewayManifest` is a faithful projection — leave it projecting the new fields too).
- [ ] **Step 5: Run** `pnpm typecheck && pnpm lint && pnpm test` → PASS.
- [ ] **Step 6: Commit** `feat(integrations): carry the manifest fields BorderConnect needs in ManifestPayload`.

---

### Task 4: BorderConnect HTTP + fixture transport, vendored schemas

**Files:**
- Create: `packages/integrations/src/customs/borderconnect/transport.ts`, `transport.test.ts`, `schemas/{ace-emanifest,aci-emanifest,ace-send-request,aci-send-request,api-response,ace-response,aci-response,aci-notice,rns-shipment}-schema.json`
- Modify: `packages/integrations/package.json` (devDependencies `ajv@^8` and `ajv-formats` — `ajv` is present only transitively at v6 via eslint, so a direct v8 dep is required; if the vendored schemas declare draft 2020-12, import from `ajv/dist/2020`. `resolveJsonModule` is already on.)

**Interfaces (Produces):**
```ts
export interface BorderConnectTransport {
  send(message: Record<string, unknown>): Promise<{ status: string }>;   // POST /api/send/{suffix}
  receive(): Promise<Record<string, unknown>[]>;                         // GET /api/receive/{suffix}, normalised
}
export interface BorderConnectHttpOptions { apiUrlSuffix: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number; baseUrl?: string /* default https://borderconnect.com */ }
export function createBorderConnectHttpTransport(o: BorderConnectHttpOptions): BorderConnectTransport;
export function normaliseReceiveBody(body: unknown): Record<string, unknown>[];
export const BORDERCONNECT_ERROR_CODES = ["MISSING_API_KEY","INVALID_API_KEY","EXPIRED_API_KEY","API_KEY_URL_MISMATCH","FAILED_TO_IMPORT_DATA","WRONG_HTTP_METHOD","TOO_MANY_REQUESTS"] as const;
```

- [ ] **Step 1: Vendor the schemas:** `for n in ace-emanifest aci-emanifest ace-send-request aci-send-request api-response ace-response aci-response aci-notice rns-shipment; do curl -fsSL "https://borderconnect.com/emanifest-api/manual/$n-schema.json" -o packages/integrations/src/customs/borderconnect/schemas/$n-schema.json; done` — if any 404s, note it in the README and skip that schema's ajv test.
- [ ] **Step 2: Write `transport.test.ts`** (pattern: `gateway/client.test.ts` "http transport" block, injected `fetchImpl`): `send posts JSON to https://borderconnect.com/api/send/<suffix> with Api-Key and Content-Type headers`; `send returns {status:"OK"}`; `a 401 {"status":"FAILURE","errorCode":"EXPIRED_API_KEY"} throws CustomsTransportError(401, retryable=false) whose message contains EXPIRED_API_KEY`; `"FAILED" spelling is parsed the same`; `429 TOO_MANY_REQUESTS is retryable`; `5xx retryable`; `timeout → 504 retryable`; `normaliseReceiveBody`: `[]`→`[]`, `null/""`→`[]`, `[{data:"X"}]`→same, `{messages:[…]}`→inner, `{data:"API_RESPONSE",…}`→`[obj]`, `{status:"OK"}` (no data) → `[]`.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** mirroring `gateway/transport.ts` (AbortController, `retryable = 429 || >=500`, `safeJson`), header `"Api-Key": apiKey`, error message `BorderConnect: <errorCode> (<status>)`.
- [ ] **Step 5: Run** `pnpm --filter @corridor/integrations test -- borderconnect/transport` → PASS. **Step 6: Commit** `feat(integrations): BorderConnect HTTP transport and vendored JSON schemas`.

---

### Task 5: Outbound mappers — `ACE_TRIP`, `ACI_TRIP`, send requests, validation

**Files:**
- Create: `borderconnect/format.ts`, `code-lists.ts`, `validate.ts`, `ace.ts`, `aci.ts`, `send-request.ts`, and tests `ace.test.ts`, `aci.test.ts`, `send-request.test.ts`, `format.test.ts`

**Interfaces (Produces):**
```ts
export interface OutboundOptions { companyKey: string; sendId: string; operation: "CREATE" | "UPDATE"; autoSend: boolean;
  /** Amend/cancel must reuse the trip number already on file (customs_submissions.reference_number). */
  tripNumberOverride?: string }
export function tripNumberFor(m: ManifestPayload): string;                 // format.ts — see rules below
export function bcDateTime(iso: string, timeZone: string): string;         // "yyyy-mm-dd hh:mm:ss", rounded to nearest 15 min, in timeZone
export function toAceTrip(m: ManifestPayload, o: OutboundOptions): Record<string, unknown>;   // throws CustomsTransportError 422
export function toAciTrip(m: ManifestPayload, o: OutboundOptions): Record<string, unknown>;
export function toCancelSendRequest(regime: Regime, tripNumber: string, o: Pick<OutboundOptions,"companyKey"|"sendId">): Record<string, unknown>;
export function validateForBorderConnect(m: ManifestPayload): string[];    // list of "path: problem"; [] when valid
```

Rules the code must encode (from the ACE/ACI JSON reference PDFs):
- `tripNumberFor`: use `m.trip.tripNumber` if it matches the regime pattern (ACE `^[A-Z]{4}[A-Z0-9]{4,21}$`, ACI `^[A-Z0-9-]{4}[A-Z0-9]{4,21}$` with O→0, I→1 normalisation on ACI); else derive `${m.carrier.code}${m.trip.movementNumber.replace(/[^A-Za-z0-9]/g,"").toUpperCase()}`; if that also fails the pattern → 422 `trip.tripNumber: must start with the carrier code and be 8–25 alphanumerics`.
- `bcDateTime`: `Intl.DateTimeFormat("en-CA", {timeZone, hourCycle:"h23", …})` parts → `YYYY-MM-DD HH:mm:ss`, minutes rounded to nearest 15 (carry over to the hour/day). Fetch `https://borderconnect.com/data/time-zones.json` while implementing: if its codes are IANA names, also send `estimatedArrivalTimeZone: m.carrier.timezone`; if not, omit the field and note the list in the README.
- Ports: `usPortOfArrival` / `portOfEntry` = `m.trip.portOfEntry.padStart(4,"0")`.
- ACE truck: `{ number: unitNumber, type: truckType, vinNumber: vin (422 if null), licensePlates: [{number: plate, stateProvince: plateJurisdiction}, …plates].slice(0,2), sealNumbers, dotNumber? }`; trailers: `{ number, type, licensePlates: [...], sealNumbers }` — fetch `https://borderconnect.com/data/trailer-types.json` and map `equipment_types.code` (TF/FT/TK…) onto it in `code-lists.ts` (422 on an unmapped code). ACI truck uses singular `licensePlate` and `type`/`vinNumber` optional.
- Drivers: crew with role `person_in_charge` / `crew_member` → `{ firstName, lastName, gender (only "M"/"F"; "X" omitted), dateOfBirth, citizenshipCountry: citizenship, fastCardNumber: first document of type "fast" whose number matches `^4270[0-9]{8}0[12]$`, travelDocuments: documents mapped through a `DriverDocumentType → travel-document-types.json` table in `code-lists.ts` (fetch the list; unmapped types omitted) }`. ACE requires ≥1 driver (422). Passengers (role `passenger`) → ACE `passengers[]` requires gender, dateOfBirth, citizenshipCountry, travelDocuments — 422 listing the missing ones. Never emit `primaryEmail` / `secondaryEmail` objects.
- ACE shipments: `type` from `code-lists.ACE_SHIPMENT_TYPES` — the domain values are `ACE_SHIPMENT_TYPES` in `packages/domain` (`regular_bill`, `section_321`, `goods_astray`, `in_bond`, … — read the array, not the SQL): `regular_bill`→`PAPS`, `goods_astray`→`GOODS_ASTRAY`, `in_bond`→`IN_BOND`, and every other value 422 with "no BorderConnect shipment type for <value>" until confirmed. Packaging: `commodities.packaging_type` / `quantity_unit` hold CBP *names* ("Box"), not codes — map name → code case-insensitively through the vendored `packaging-unit.json` (`name` field), 422 when unmatched. `shipmentControlNumber` = `controlNumber` (pattern `^[A-Z]{4}[A-Z0-9]{4,12}$`, 422). `provinceOfLoading` = `loading.province` (422 if null). `shipper`/`consignee` = `{ name, address: { addressLine: [line1,line2].filter(Boolean).join(" "), city, postalCode, stateProvince: region, country } }` — name, addressLine, city, postalCode 422 if null. `commodities[]` = `{ description, quantity (422 if null), packagingUnit: packagingType (422 if null or not in `code-lists.ACE_PACKAGING_UNITS`), weight: weightKg (422 if null), weightUnit: "KG", marksAndNumbers: [s] if set, harmonizedCode: hsCode?, value?, countryOfOrigin? }`. Hazmat lines → 422 `commodities[j].hazmat: BorderConnect requires an emergency contact Corridor does not capture yet`. `shipmentType === in_bond` → 422 `inBond: irsNumber/fda not captured yet` (v1). `iitIndicator` → `instrumentsOfInternationalTrafficBond: { type: "CARRIER" | "IMPORTER" }`, omitted when `none`.
- ACI shipments: `shipmentType` via `code-lists.ACI_SHIPMENT_TYPES`: `isPars` is not on the payload — use `controlNumber.includes("PARS")` **or** `cargoType`: `csa`→`CSA`, `a49`→`A49`, `e29b`→`E29B`, `shipmentType in_bond`→`BOND`, `consolidated`→`PARS` + `consolidatedFreight: true`, `regular` with a PARS control number →`PARS`, otherwise 422 `shipmentType: a plain non-PARS ACI shipment has no confirmed BorderConnect type (open risk)`. `cargoControlNumber` = `controlNumber`; `portOfEntry` + `releaseOffice` = trip port; `estimatedArrivalDate` = trip ETA; `cityOfLoading: { cityName: loading.city, stateProvince: loading.province }` (422 if either null); `shipper`/`consignee` as ACE; `deliveryDestinations: [{ name: consignee.name, address }]` when `delivery` postal is set; commodities as ACE but `marksAndNumbers` is a string and `packagingUnit` from `ACI_PACKAGING_UNITS`. Any of `m.trip.aci.{lvs,postal,flyingTruck,inTransit,iit}` true → 422 `trip.aci.<flag>: not representable in the BorderConnect eManifest API`.
- Both: top-level `data`, `sendId`, `companyKey`, `operation`, `autoSend`, `tripNumber`, ETA; `companyKey` also on every nested shipment; nested `ACE_SHIPMENT`/`ACI_SHIPMENT` never carries its own `operation`.
- `toCancelSendRequest`: ACE `{ data: "ACE_SEND_REQUEST", type: "CANCEL_TRIP_AND_SHIPMENTS", tripNumber, companyKey, sendId }`; ACI `{ data: "ACI_SEND_REQUEST", type: "CANCEL", bundleTripAndShipments: true, tripNumber, companyKey, sendId }`.

- [ ] **Step 1: Write the tests.** `format.test.ts` (tripNumber derivation and rejection; `bcDateTime` rounding 14:37→14:30, 14:38→14:45, 23:53→next day 00:00, timezone). `ace.test.ts`: a full valid ACE manifest (reuse `makeSource()` from Task 3 through `buildManifest`) → `toAceTrip` output validates with ajv against `schemas/ace-emanifest-schema.json` (`new Ajv({ strict: false, allErrors: true })`), snapshot the shape; `companyKey on trip and every shipment`; `operation/autoSend passthrough`; each 422 rule above has one test asserting the error lists *all* missing fields at once (e.g. remove vin **and** provinceOfLoading → both named). `aci.test.ts` same against `aci-emanifest-schema.json` plus the shipment-type table and the ACI-flag 422. `send-request.test.ts` validates both cancel requests against their schemas.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `format.ts`, `code-lists.ts` (fetch and vendor the small lists as `as const` arrays with the source URL in a comment), `validate.ts` (collects problems; `toAceTrip`/`toAciTrip` call it and throw `new CustomsTransportError(`BorderConnect: manifest is missing ${problems.length} required field(s): ${problems.join("; ")}`, 422, false)`), then the mappers.
- [ ] **Step 4: Run** `pnpm --filter @corridor/integrations test -- borderconnect` → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** `feat(integrations): map ManifestPayload to BorderConnect ACE_TRIP / ACI_TRIP with schema-validated tests`.

---

### Task 6: Inbound parser and the new customs event codes

**Files:**
- Modify: `packages/domain/src/customs-events.ts:8-34`
- Create: `borderconnect/inbound.ts`, `inbound.test.ts`, `fixtures/inbound/*.json`

**Interfaces (Produces):**
```ts
// packages/domain
CUSTOMS_EVENT_CODES += "pars_matched" | "pars_not_matched" | "review_time_warning" | "csa_reported" | "import_error" | "entry_number_assigned"
// borderconnect/inbound.ts
export type BorderConnectInbound =
  | { kind: "api_response"; companyKey: string | null; sendId: string | null; ok: boolean; status: string; message: string; errors: string[]; tripNumber: string | null; raw }
  | { kind: "customs_status"; companyKey: string | null; keys: { tripNumber?: string; cargoControlNumber?: string; shipmentControlNumber?: string }; status: CustomsStatusMessage /* referenceNumber = tripNumber or "" */; raw }
  | { kind: "rns"; cargoControlNumber: string; transactionNumber: string | null; releaseCode: string | null; releaseName: string | null; releasedAt: string; officeCode: string | null; raw }
  | { kind: "alert"; message: string; raw }
  | { kind: "unknown"; dataType: string; companyKey: string | null; raw };
export function parseInbound(msg: unknown): BorderConnectInbound;
export function inboundKeys(msg: unknown): { dataType: string; companyKey: string|null; sendId: string|null; tripNumber: string|null; cargoControlNumber: string|null; shipmentControlNumber: string|null };
```

Mapping table (encode as data, one test per row):

| Message | → `status` / `decision` | events (code) |
|---|---|---|
| `API_RESPONSE` status OK/QUEUED/IMPORTED/TRANSMITTED/COMPLETED | `ok: true` (submission → `acknowledged`) | — |
| `API_RESPONSE` DATA_ERROR/SEND_ERROR/SYNC_ERROR/ACCESS_DENIED_ERROR/IMPORTED_WITH_ERRORS/PROCESSED_WITH_ERRORS | `ok: false` → `rejected`, message = `errors[].identifier: note` joined | `import_error` |
| `ACE_RESPONSE.validationResponses[]` non-empty | `rejected` | `rejected` per entry (`code – description`) |
| `ACE_RESPONSE.processingResponse` (no validation errors) | `accepted` | `accepted` |
| `ACE_RESPONSE.tripStatus` AAD/19 | decision `null`, events only | `arrival_recorded` |
| tripStatus RTR / RCO | `released` | `released` |
| tripStatus HTR | `held` | `held` |
| `ACE_RESPONSE.shipmentStatusList[]` 02/05 (+entryNumber) | events only | `entry_on_file` (shipmentControlNumber, entryNumber, port) |
| 1C | events only; `shipments[]` status `released` | `entered_and_released` |
| 1G/1H | `held` | `held` |
| 11/12/13/19 | events only | `arrival_recorded` |
| 1D | events only | `entry_on_file` |
| other codes | events only | `preliminary_check_passed` with raw code/description in `raw` |
| `ACI_RESPONSE` type ACCEPT | `accepted` | `accepted` |
| `ACI_RESPONSE` type REJECT | `rejected`, message = `errorResponses[].errorCode errorField: errorDescription/errorText` | `rejected` |
| `ACI_NOTICE` ARRIVAL_REPORTED | events only | `arrival_recorded` (one per `references[]` CCN, or trip-level) |
| MATCHED | events only | `pars_matched` |
| NOT_MATCHED | events only | `pars_not_matched` |
| CSA_REPORTED | events only | `csa_reported` |
| INSUFFICIENT_REVIEW_TIME_WARNING | events only | `review_time_warning` |
| `RNS_SHIPMENT` | `kind: "rns"` | (handled in Task 11) |
| `SYSTEM_ALERT` | `kind: "alert"` | — |

- [ ] **Step 1: Save fixture messages** under `fixtures/inbound/` — one JSON per row above, built from the examples in the ACE/ACI Response, ACI Notice, API Response and RNS Shipment PDFs (companyKey `c-9000-2bcd8ae5954e0c48`, tripNumber `ABCD260912001`, CCN `1234PARS0001`).
- [ ] **Step 2: Write `inbound.test.ts`**: one `it` per table row loading its fixture and asserting `kind`, `status.status`, `status.decision`, event codes, `shipments[]`, keys; plus `unknown data type is preserved`, `missing data field → unknown`, `companyKey null when absent`.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** `customs-events.ts` (codes + labels: "PARS matched", "PARS not matched", "Insufficient review time", "CSA reported", "Import error", "Entry number assigned") and `inbound.ts` (pure functions, `occurredAt` from `cbpDateTime`/`cbsaDateTime`/`dateTime` → ISO).
- [ ] **Step 5: Run** `pnpm --filter @corridor/domain test && pnpm --filter @corridor/integrations test -- inbound` → PASS. **Step 6: Commit** `feat(integrations): parse BorderConnect inbound messages into customs status events`.

---

### Task 7: `createBorderConnectCustomsClient`, fixture replay, wiring into `createCustomsClient`

**Files:**
- Create: `borderconnect/client.ts`, `client.test.ts`, `fixtures/outcomes/{ace,aci}-{accepted,held,rejected}.json`, `README.md`
- Modify: `packages/integrations/src/customs/types.ts:195` (`CustomsClientMode`), `index.ts:34-66` (+ exports), `fixture-state.ts` (new store `borderConnectQueue`)

**Interfaces (Produces):**
```ts
export interface BorderConnectClientOptions {
  provider: "cbp_ace" | "cbsa_aci"; environment?: "sandbox" | "production";
  apiUrlSuffix: string | null; apiKey: string | null; companyKey: string | null;
  transport?: BorderConnectTransport; now?: () => Date; tenantKey: string;
}
export function createBorderConnectCustomsClient(o: BorderConnectClientOptions): CustomsClient & { readonly live: boolean };
export function createFixtureBorderConnectTransport(tenantKey: string, now: () => Date): BorderConnectTransport;
// index.ts: createCustomsClient input gains { apiUrlSuffix?: string|null; companyKey?: string|null }; mode "border_connect" branch.
```

Behaviour:
- `live = !!(apiUrlSuffix && apiKey)`; transport = `opts.transport ?? (live ? http : fixture)`.
- `transmit(manifest, {correlationId})`: `sendId = correlationId ?? randomUUID()`; `companyKey` 422 if null **and live**; body = `toAceTrip|toAciTrip(manifest, {companyKey: companyKey ?? "fixture", sendId, operation: "CREATE", autoSend: true})`; `await transport.send(body)`; return `{ referenceNumber: tripNumber, receivedAt: now().toISOString(), decisionEtaMs: 0, raw: { borderConnect: true, live, sendId, status } }`. (`decisionEtaMs` is unused in this mode — Task 8 stops scheduling.)
- `amend(manifest, referenceNumber, opts)`: same with `operation: "UPDATE"` and `tripNumberOverride: referenceNumber` (Task 5's `OutboundOptions`), so the re-upload targets the trip already on file.
- `cancel(referenceNumber, reason)`: `transport.send(toCancelSendRequest(regime, referenceNumber, {companyKey, sendId}))` → `{ referenceNumber, cancelledAt, raw }`.
- `fetchStatus`, `fetchDecision`, `fetchNotices`, `inBondArrival`, `inBondExport`, `inBondCancel`, `inBondStatus` → `throw new CustomsTransportError("<method> is not supported in border_connect mode — status arrives through the BorderConnect inbox", 501, false)`.
- `parseInbound` → returns `null` (no signed webhook in this mode).
- `ping()` → `transport.receive()`; **the client's ping must not be used in production** (it drains the queue) — it exists for the fixture path and tests; Task 10 routes the Settings "Test connection" to the drain instead. Return `{ ok: true, mode: "border_connect", live, detail: { messages: n } }`.
- Fixture transport: `send()` records the message in `borderConnectQueue` (a `createFixtureStore` keyed by tenantKey) and, keyed on `fixtureOutcomeFor`-style suffix of the first shipment control number (`H` held, `R` rejected, else accepted — reuse `fixtureOutcomeFor` from `gateway/client.ts`), enqueues `API_RESPONSE IMPORTED` + the matching `fixtures/outcomes/<regime>-<outcome>.json` (ACE: `ACE_RESPONSE` with processingResponse / validationResponses / tripStatus HTR; ACI: `ACI_RESPONSE` ACCEPT/REJECT or `ACI_NOTICE`), each stamped with the sent `companyKey`, `sendId`, `tripNumber`. `receive()` drains and returns them. Cancel send enqueues `API_RESPONSE TRANSMITTED`.

- [ ] **Step 1: Write `client.test.ts`** (pattern `gateway/client.test.ts`; `beforeEach(clearCustomsFixtureState)`): transmit returns tripNumber as reference and raw.sendId; fixture receive yields IMPORTED + accepted for a normal control number, rejected for `…R`, held for `…H`; amend sends `operation: "UPDATE"` with the original tripNumber; cancel sends the right send-request per regime; every unsupported method throws `CustomsTransportError` 501 (one test iterating the seven names — so a future edit cannot quietly succeed with a wrong mapping); `live` client with injected transport sends `companyKey` from options and refuses to transmit with `companyKey: null` (422); `createCustomsClient({mode:"border_connect"})` returns a client with `mode === "border_connect"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** client, fixture transport, `CustomsClientMode = "mock" | "gateway" | "border_connect"`, `index.ts` branch:
```ts
if (input.mode === "border_connect") {
  return createBorderConnectCustomsClient({ provider, environment: input.environment ?? "sandbox",
    apiUrlSuffix: input.apiUrlSuffix ?? null, apiKey: input.apiKey ?? null,
    companyKey: input.companyKey ?? null, tenantKey: input.tenantKey });
}
```
and exports (`createBorderConnectCustomsClient`, `createBorderConnectHttpTransport`, `normaliseReceiveBody`, `parseInbound`, `inboundKeys`, `toAceTrip`, `toAciTrip`, `toCancelSendRequest`, `type BorderConnectInbound`, `type BorderConnectTransport`).
- [ ] **Step 4: README.md** — mode selection, env vars, message flow diagram (send → API_RESPONSE → ACE/ACI_RESPONSE → inbox), fixture suffix table, the open-risk list from Task 1.
- [ ] **Step 5: Run** `pnpm typecheck && pnpm lint && pnpm test` → PASS (the literal `"gateway"` assertions in `gateway/client.test.ts:59`, `customs.test.ts:179,219`, `customs.integration.test.ts:113` are unaffected). **Step 6: Commit** `feat(integrations): border_connect customs client with offline fixture replay`.

---

### Task 8: API wiring — `customsClientFor`, no per-movement polling, router enum

**Files:**
- Modify: `packages/api/src/services/customs.ts:129-178` (`customsClientFor`), `:218-241` (`scheduleDecision`), `packages/api/src/router/integrations.ts:70` (`mode` enum), `packages/api/src/services/notices.ts` (no change — env-level notices client stays `gateway|mock`)
- Test: `packages/api/src/services/customs.test.ts`

- [ ] **Step 1: Tests** (use `createFakeDb` / `TEST_ORG_ID` from `../test/mock-context` as the existing `pollCustomsStatus` tests do): `customsClientFor returns a border_connect client carrying the org's company key and the env suffix/key`; `in production with mode border_connect and no company key → PRECONDITION_FAILED "BorderConnect company key is not set"`; `in sandbox with no BORDERCONNECT_API_KEY the client is not live (fixture)`; `scheduleDecision enqueues nothing for a border_connect client` (spy `enqueueJob`); `transmitMovement in border_connect mode records a customs_submissions row with mode border_connect and status acknowledged` (existing transmit test scaffold).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement:**
```ts
// customsClientFor
const mode = cfg?.mode ?? "mock";
const org = mode === "border_connect"
  ? (await tx.select({ companyKey: schema.organizations.borderConnectCompanyKey }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1))[0]
  : undefined;
if (mode === "border_connect" && environment === "production" && !org?.companyKey)
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "BorderConnect company key is not set for this organization (Settings → Organization)" });
// createCustomsClient({...existing, apiUrlSuffix: process.env.BORDERCONNECT_API_URL_SUFFIX ?? null,
//   apiKey: mode === "border_connect" ? (process.env.BORDERCONNECT_API_KEY ?? null) : <existing expression>,
//   companyKey: org?.companyKey ?? null })
```
Keep the existing `gateway` credential/baseUrl gates untouched, but the Vault read at L149-152 (`(mode === "gateway" || environment === "production") && cfg?.credentialsRef`) must **not** run for `border_connect` — the key is EasyTask's, from env, never per-org Vault: `mode !== "border_connect" && (…existing condition…)`. `scheduleDecision` currently has an `else` arm that enqueues `customs.decide` for every non-gateway mode (L233-239) — that handler calls `fetchDecision`, which throws in this mode — so add an explicit first arm: `if (client.mode === "border_connect") return;` with a one-line comment "status arrives through customs.borderconnect_drain". Router: `mode: z.enum(["mock", "gateway", "border_connect"])`; when `mode === "border_connect"` force `baseUrl: null` server-side.
- [ ] **Step 4: Run** `pnpm --filter @corridor/api test && pnpm typecheck && pnpm lint` → PASS. **Step 5: Commit** `feat(api): file through BorderConnect when an organization's customs mode is border_connect`.

---

### Task 9: `applyStatusMessage` events-only branch

**Files:**
- Modify: `packages/api/src/services/movements.ts:120-190` (extract `recordCustomsEvents`), `packages/api/src/services/customs.ts:608-665` (`applyStatusMessage`)
- Test: `packages/api/src/services/customs.test.ts` (`applyStatusMessage` block at L118)

**Interfaces (Produces):**
```ts
// movements.ts
export async function recordCustomsEvents(tx: Tx, actor: Actor, m: MovementRow, events: CustomsEventMessage[], outcomes: CustomsShipmentMessage[]): Promise<void>;
// = the body of applyShipmentOutcomes minus the decision-driven status cascade; applyShipmentOutcomes calls it then cascades.
```

- [ ] **Step 1: Tests:** `a status message with decision null and events writes customs_event rows and shipment entry numbers without changing movement status` (movement `accepted`, event `entry_on_file` with `entryNumber` → shipment `entryNumber` set, status unchanged, `changed: false`, `terminal: false`); `an RNS-flagged ACI event (raw.rns === true) still lands in pars_rns_events through the events-only path`; existing decision tests unchanged.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement:** in `applyStatusMessage` add after the `cancelled`/`decision` branches: `else if (status.events.length > 0 || status.shipments.length > 0) { if (["sent","accepted","held"].includes(current.status)) await recordCustomsEvents(tx, actor, current, status.events, status.shipments); }`. Keep the `customs_submissions.status` stamp logic as is.
- [ ] **Step 4: Run** `pnpm --filter @corridor/api test` → PASS. **Step 5: Commit** `refactor(api): record events-only customs status messages without a decision`.

---

### Task 10: The inbox drain — service, job, cron route, Test-connection

**Files:**
- Create: `packages/api/src/services/borderconnect.ts`, `packages/api/src/services/borderconnect.test.ts`, `apps/web/src/app/api/jobs/borderconnect-drain/route.ts`
- Modify: `packages/api/src/services/jobs.ts:34-43` (JobType), `:169-277` (detached handler), `apps/web/vercel.json` (cron `* * * * *`), `packages/api/src/router/integrations.ts:199-229` (`testCustoms`), `packages/api/src/index.ts` exports if the route needs `drainBorderConnectInbox`
- Test: `packages/api/src/jobs.integration.test.ts` (detached-handler assertion like L295), `packages/db/src/customs.integration.test.ts` (nobody but service role enqueues `customs.borderconnect_drain`)

**Interfaces (Produces):**
```ts
export function borderConnectEnv(): { apiUrlSuffix: string | null; apiKey: string | null; live: boolean };
export async function storeInboundMessages(tx: RlsTransaction, messages: Record<string, unknown>[]): Promise<{ stored: number; duplicates: number }>;  // sha256(JSON.stringify(msg)) → payload_sha256, onConflictDoNothing; fills data_type + keys via inboundKeys()
export async function processInboxRow(db: DatabaseClient, rowId: number): Promise<{ outcome: "applied" | "acknowledged" | "unroutable" | "ignored" | "rns" | "alert"; detail?: string }>;
export async function drainBorderConnectInbox(db: DatabaseClient, opts?: { transport?: BorderConnectTransport; limit?: number }): Promise<{ received: number; stored: number; duplicates: number; processed: Record<string, number>; errors: number }>;
```

Routing inside `processInboxRow` (one `withServiceRole` transaction per row; on throw: `processing_error = message`, `processed_at` **stays null** so the next drain retries, but after 5 failures (`processing_error` prefixed with `attempt=N`) mark processed with the error to avoid poison rows):
1. `parsed = parseInbound(row.payload)`. `alert` → Task 11. `rns` → Task 11.
2. `org` = `organizations where border_connect_company_key = row.company_key`. None → `processed_at = now(), processing_error = "unknown companyKey"`, outcome `unroutable`.
3. `api_response`: submission = `customs_submissions where organization_id = org and correlation_id = sendId` (fallback: `reference_number = tripNumber`, latest). None → unroutable. `ok` → `status = "acknowledged"` (only if currently `sent`/`acknowledged`), outcome `acknowledged`. Not ok → load the movement (`requireMovement`), `applyStatusMessage(tx, {orgId, userId:null}, m, { referenceNumber: submission.reference_number, status: "rejected", decision: "rejected", message, events: [import_error], shipments: [], raw })` → outcome `applied`.
4. `customs_status`: movement by `tripNumber` → `customs_submissions.reference_number` within org (latest with a movement), else by `cargoControlNumber ?? shipmentControlNumber` → `shipments.control_number` within org → `movement_id`. None → unroutable. Then `lockMovement`, `logIntegrationEvent({ direction: "inbound", operation: `borderconnect.${dataType.toLowerCase()}`, correlationId: `bc-inbox:${row.id}`, request: { keys }, response: { status, decision, events: n } })`, `applyStatusMessage(...)` with `referenceNumber` = the submission's reference. Set `movement_id`, `customs_submission_id`, `processed_at`.
5. `unknown` → `processed_at = now()`, `processing_error = "unhandled data type <X>"`, outcome `ignored`.

`drainBorderConnectInbox`: phase A (no tx) `transport.receive()`; phase B `withServiceRole(storeInboundMessages)`; phase C select `id from customs_inbox where processed_at is null order by id limit 200` and `processInboxRow` each; `logIntegrationEvent` is per-row (org-scoped), so the drain itself logs nothing global — return counts. When `!borderConnectEnv().live` and no transport injected, use `createFixtureBorderConnectTransport("system", …)` so local dev end-to-end works (transmit → fixture queue → drain → accepted).

Job + route:
```ts
// jobs.ts
| "customs.borderconnect_drain"
"customs.borderconnect_drain": async (db) => { const { drainBorderConnectInbox } = await import("./borderconnect"); return drainBorderConnectInbox(db); },
// route.ts (mirror notices-sync): enqueueJob({ orgId: null, jobType: "customs.borderconnect_drain", payload: {}, idempotencyKey: `bc-drain:${new Date().toISOString().slice(0,16)}`, maxAttempts: 2 }) then processDueJobs(db, { limit: 5, worker: "cron-borderconnect" })
// vercel.json: { "path": "/api/jobs/borderconnect-drain", "schedule": "* * * * *" }
```
`testCustoms`: if the org's config mode is `border_connect`, run `drainBorderConnectInbox(ctx.db)` **outside** `ctx.rls` — `withServiceRole` must never be opened inside an RLS transaction (`packages/db/src/rls.ts:61-70`); follow the `jobs.runNow` shape at `router/integrations.ts:316-330`: read the config in one `ctx.rls`, drain on `ctx.db`, then audit in a second `ctx.rls`. Messages are stored, never discarded, so this is safe to click. Return `{ ok: true, mode: "border_connect", live, detail: { received, stored } }`.

- [ ] **Step 1: Tests (`borderconnect.test.ts`, vitest unit with the fake db, or an integration test under `packages/api/src/*.integration.test.ts` — pick the integration form since routing depends on RLS-free service-role queries and real FKs):** seed org A (`company_key = "c-A"`) and org B (`"c-B"`) with one `sent` ACE movement + `customs_submissions` row each (`reference_number = tripNumber`, `correlation_id = sendId`); an injected transport whose `receive()` returns: API_RESPONSE IMPORTED for A; ACE_RESPONSE processingResponse for A; ACI_NOTICE MATCHED for B (events-only); an API_RESPONSE DATA_ERROR for B's second submission; one message with companyKey `c-Z`; the A message duplicated. Assert: A `accepted` with an `accepted` customs_event; B's movement unchanged but has a `pars_matched` event; B's second submission `rejected`; the `c-Z` row kept with `processing_error = "unknown companyKey"`; one duplicate row; every processed row has `processed_at`, `movement_id`; `integration_events` rows have `correlation_id = bc-inbox:<id>`; a second drain with an empty receive processes nothing. Plus `jobs.integration.test.ts`: `customs.borderconnect_drain` is a detached handler and an org-null job is claimable.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** service, job, route, vercel cron, router branch. **Step 4: Run** `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration` → PASS.
- [ ] **Step 5: Manual check:** `pnpm dev`, set an org's ACE config to `border_connect` (Task 13 UI not yet there — use the tRPC upsert from the browser console or a seed tweak), transmit a movement, `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/jobs/borderconnect-drain`, movement shows `accepted`.
- [ ] **Step 6: Commit** `feat(api): drain the BorderConnect inbox into movements every minute`.

---

### Task 11: RNS releases and SYSTEM_ALERT notices

**Files:**
- Modify: `packages/api/src/services/borderconnect.ts` (`processInboxRow` branches), `packages/api/src/services/notices.ts` (extract `recordCarrierNotices(tx, notices)` from `syncCarrierNotices` so the drain can reuse the insert + fan-out)
- Test: the Task 10 integration test file

Behaviour:
- `rns`: **there is no companyKey on RNS_SHIPMENT**, and `shipments.control_number` is unique only per organization (`shipments_organization_id_control_number_key`), so resolve across orgs: candidates = `shipments where control_number = cargoControlNumber`; if several, keep those whose movement is ACI and in `sent|accepted|held`; exactly one left → route to it; 0 or still >1 → unroutable with `processing_error = "ambiguous CCN (<n> candidates)"` / `"unknown CCN"`. Insert `pars_rns_events { organizationId, shipmentId, parsNumber: cargoControlNumber, releaseCode: releaseCode.number, releasedAt, officeCode: releaseOffice.number, transactionNumber, raw }` (same columns `movements.ts:154-166` writes). If `releaseCode` denotes a release (fetch `https://borderconnect.com/data/ca/rns/release-codes.json` or the RNS PDF list while implementing; vendor the "released" subset in `code-lists.ts`), stamp `shipments.status = "released", released_at` through the existing shipment-status rules (see `SHIPMENT_STAMP` in movements.ts) and, if the shipment has a movement, add a `customs_event` with code `released` and `raw: { rns: true, ... }` via `recordCustomsEvents`.
- `alert`: `recordCarrierNotices(tx, [{ provider: "cbsa_aci" and "cbp_ace" (two rows), externalId: `borderconnect:${sha256}`, severity: "warning", title: "BorderConnect system alert", body: message, publishedAt: receivedAt }])`; fan-out is whatever `syncCarrierNotices` already does.

- [ ] **Step 1: Tests:** RNS message for a PARS shipment on an accepted ACI movement → `pars_rns_events` row, shipment `released`, a `released` customs_event on the movement; RNS for an unknown CCN → unroutable; SYSTEM_ALERT → two `carrier_notices` rows, second identical alert deduped by `external_id`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm test && pnpm test:integration` → PASS. **Step 5: Commit** `feat(api): apply BorderConnect RNS releases and system alerts from the inbox`.

---

### Task 12: `crossingReadiness()` and its API exposure

**Files:**
- Create: `packages/domain/src/readiness.ts`, `readiness.test.ts`; export from `packages/domain/src/index.ts`
- Modify: `packages/api/src/router/movement.ts` (`get` output gains `readiness`), `packages/api/src/services/movements.ts` (`loadFull` already returns events + shipments; add latest `pars_rns_events` per shipment for ACI)

**Interfaces (Produces):**
```ts
export type ReadinessState = "ok" | "pending" | "blocked";
export interface ReadinessCheck { key: string; label: string; state: ReadinessState; detail: string | null }
export interface CrossingReadiness { ready: boolean; checks: ReadinessCheck[] }
export function crossingReadiness(input: {
  regime: Regime; status: MovementStatus;
  shipments: Array<{ controlNumber: string; status: ShipmentStatus; entryNumber: string | null; isPars: boolean; rnsReleasedAt: string | null }>;
  events: Array<{ code: CustomsEventCode; shipmentControlNumber: string | null; occurredAt: string }>;
}): CrossingReadiness;
```
Checks — ACE: `manifest` (status accepted/released → ok; sent → pending; rejected/held → blocked), `entries` (every non-in-bond shipment has `entryNumber` or an `entry_on_file`/`entered_and_released` event → ok; else pending), `holds` (any `held` event after the last `accepted`/`released` → blocked), `rejects` (last `rejected` newer than last `accepted` → blocked). ACI: `manifest`, `pars_match` (every PARS shipment has `pars_matched`; `pars_not_matched` → blocked), `rns_release` (every PARS shipment `rnsReleasedAt` or shipment status released → ok; else pending), `rejects`. `ready = every check ok`. Empty trip (`isEmpty`) → only `manifest` + `rejects`.

- [ ] **Step 1: Tests:** one per check state per regime, plus `ready` true only when all ok, empty-trip case. **Step 2: Run** → FAIL. **Step 3: Implement** the pure function; in `movement.get` compute `readiness: crossingReadiness({...})` from `loadFull` data (+ a small `latestRnsByShipment(tx, shipmentIds)` select on `parsRnsEvents`). **Step 4: Run** `pnpm test && pnpm typecheck` → PASS. **Step 5: Commit** `feat(domain,api): ready-to-cross readiness rollup on movement.get`.

---

### Task 13: Settings UI — BorderConnect mode and the Company Key field  *(invoke `ui-ux-pro-max` first)*

**Files:**
- Modify: `apps/web/src/app/(app)/settings/integrations/integrations-panel.tsx:17-49` (PROVIDERS), `:127-160` (submit), `:138` (mode cast), `:221-243` (mode select + baseUrl), `:294` (credentials), `:355` (Test connection copy)
- Modify: `apps/web/src/app/(app)/settings/organization/organization-form.tsx:9-42` (Fields + FIELDS), `packages/domain/src/organization.ts:69` (`updateOrganizationInput` + `borderConnectCompanyKey: z.string().trim().min(1).max(64).nullable().optional()`), `packages/api/src/router/organization.ts:367-395` (`update` set + `get` already returns all columns)
- Test: `apps/web` Playwright `settings.spec.ts` (or the nearest existing settings spec) + `packages/api` router test for the update input

- [ ] **Step 1: Router/domain test:** `organization.update accepts borderConnectCompanyKey and persists it; a duplicate across orgs surfaces as CONFLICT` (map the unique violation through the shared Postgres-error → TRPCError helper, `packages/api/src/services/db-errors.ts`).
- [ ] **Step 2: Implement API + domain.** Audit via the existing `writeAudit("organization.update", …)` path.
- [ ] **Step 3: Organization form:** add `{ key: "borderConnectCompanyKey", label: "BorderConnect company key", mono: true }` with helper text "Issued by BorderConnect for your carrier account; required for BorderConnect filing mode." Blank → `null`.
- [ ] **Step 4: Integrations panel:** mode select gains `<option value="border_connect">BorderConnect</option>` (label "BorderConnect (EasyTask service provider)"); when selected, hide base URL / API key / secret inputs and show a status row `Company key: set ✓ | missing — set it in Settings → Organization` (read from `trpc.organization.get`), plus "Filing as: <SCAC> (ACE) / <CBSA code> (ACI)". Test-connection button copy in this mode: "Check inbox" (calls the same `testCustoms`, shows `received`/`stored`). Mock delay/failure inputs hidden.
- [ ] **Step 5: Playwright:** set ACE to BorderConnect with no company key → warning visible; set company key on the organization page → warning gone; save persists mode `border_connect`. Run with `PLAYWRIGHT_BASE_URL=http://localhost:3100` against a worktree server.
- [ ] **Step 6: Run** `pnpm typecheck && pnpm lint && pnpm test` + the Playwright spec → PASS. **Step 7: Commit** `feat(web): BorderConnect filing mode and company key in Settings`.

---

### Task 14: Readiness panel and list badge  *(invoke `ui-ux-pro-max` first)*

**Files:**
- Create: `apps/web/src/components/movement/readiness-panel.tsx`
- Modify: `apps/web/src/components/movement/movement-workspace.tsx` (mount above `<Timeline>` at ~L577-583), `apps/web/src/app/(app)/movements/movements-table.tsx:31-38,85` (a compact badge next to `StatusBadge`), `packages/api/src/router/movement.ts:170-176` (`list` gains `readyToCross: "ready" | "pending" | "blocked" | null` via SQL subqueries — ACE: status accepted/released and no attached shipment with `entry_number is null`; ACI: status accepted/released and every attached shipment has a `pars_rns_events` row; `held`/`rejected` → blocked; no per-row JS)
- Test: Playwright `movements.spec.ts` (existing) — assert the panel renders its checks for an accepted movement seeded by the fixture path

- [ ] **Step 1: Panel:** a compact card "Ready to cross" — one row per `ReadinessCheck` with state icon + label + detail, and a headline state (READY / WAITING / BLOCKED) using the existing `signal`/status tokens (see `status-badge.tsx`). Use `RegimeBadge` conventions; no new colour tokens.
- [ ] **Step 2: List badge** on the movements table (`ready` → green dot "Ready", `blocked` → red "Blocked", else nothing).
- [ ] **Step 3: Browser check** on :3100: seeded accepted ACE movement shows entries pending until an `entry_on_file` event arrives via the fixture drain (`curl` the drain route), then READY. **Step 4: Run** typecheck/lint/test + Playwright → PASS. **Step 5: Commit** `feat(web): ready-to-cross readiness panel and list badge`.

---

### Task 15: WebSocket listener app (hosting deferred)

**Files:**
- Create: `apps/borderconnect-listener/{package.json,tsconfig.json,src/index.ts,src/socket.ts,src/socket.test.ts,Dockerfile,README.md}`
- Modify: `pnpm-workspace.yaml` (already `apps/*`? verify), `turbo.json` (build/test pipeline includes the new app), root `README.md` apps list

**Interfaces:** reuses `storeInboundMessages` (export it from `@corridor/api`) and `getDb`/`withServiceRole` from `@corridor/db`; env `BORDERCONNECT_API_URL_SUFFIX`, `BORDERCONNECT_API_KEY`, `DATABASE_URL` (service-role Postgres URL), `SUPABASE_*` as `@corridor/db` needs.

- [ ] **Step 1: `socket.test.ts`** with a mock `WebSocket` (inject a factory): sends `{"apiKey": ...}` as the first frame within 10 s; treats the first `API_RESPONSE` `Connected` as authenticated; every later frame (object or array) is passed to `onMessages`; `ACCESS_DENIED_ERROR` closes and does **not** reconnect; other closes reconnect with capped exponential backoff (1s → 60s); ping every 30 s.
- [ ] **Step 2: Implement** `socket.ts` (`ws` dependency, `connectBorderConnectSocket({ suffix, apiKey, onMessages, wsFactory })`) and `index.ts` (wires `onMessages` → `withServiceRole(db, tx => storeInboundMessages(tx, msgs))`; processing stays in the cron drain, whose dedup makes running socket + polling together safe). Dockerfile: `node:22-alpine`, `pnpm --filter @corridor/borderconnect-listener... deploy`.
- [ ] **Step 3: README:** what it does, that it is not deployed yet, the open question whether an open socket diverts the HTTP queue (verify with Task 16's script while the container runs locally before ever relying on it), and how to run it locally (`pnpm --filter @corridor/borderconnect-listener dev`).
- [ ] **Step 4: Run** `pnpm typecheck && pnpm lint && pnpm test` → PASS. **Step 5: Commit** `feat(listener): BorderConnect WebSocket listener writing to the customs inbox`.

---

### Task 16: Live smoke script, env/docs, final verification

**Files:**
- Create: `packages/integrations/scripts/borderconnect-smoke.ts` + package script `"smoke:borderconnect": "tsx scripts/borderconnect-smoke.ts"` (there is no root `scripts/`; `tsx` is a devDep of `@corridor/db` only — add it to `@corridor/integrations`)
- Modify: `.env.example:106-121` (add `BORDERCONNECT_API_URL_SUFFIX=`, `BORDERCONNECT_TEST_COMPANY_KEY=`; drop `BORDERCONNECT_API_WEBSOCKET_URL`), `turbo.json:22-24` (env list += the three `BORDERCONNECT_*`), `apps/web/src/lib/env.ts` if it enumerates server env vars, `CHANGELOG.md` Unreleased, `docs/security-review.md` §8 (add `services/borderconnect.ts` drain + `api/jobs/borderconnect-drain` + the listener as service-role call sites; note RNS resolution is the one cross-org lookup, by carrier-prefixed control number, exactly-one-match required), `docs/user-manual/05-customs-filing.md:5` (third mode), `SECURITY.md:112`, `packages/integrations/src/customs/gateway/README.md:24-49` (point to the BorderConnect README)

- [ ] **Step 1: Smoke script:** loads `.env.local`; requires `BORDERCONNECT_API_URL_SUFFIX`, `BORDERCONNECT_API_KEY`, `BORDERCONNECT_TEST_COMPANY_KEY`; builds a minimal valid ACE manifest via `buildManifest(makeSource())` with `tripNumber = <SCAC>SMOKE<yyyymmddHHmm>` and `toAceTrip(..., { companyKey, sendId: "smoke-…", operation: "CREATE", autoSend: false })` — **`autoSend` is hard-coded `false` and the script refuses to run if the env var `BORDERCONNECT_SMOKE_AUTOSEND` is anything but unset** — POSTs it, then polls `GET receive` five times 5 s apart, printing the **raw** body (`JSON.stringify(body, null, 2)`) and `normaliseReceiveBody(body)`, then, if `--cleanup`, sends `{ data: "ACE_TRIP", operation: "DELETE", autoSend: false, tripNumber, companyKey }` and prints that response too.
- [ ] **Step 2: Run it** (`source .env.local && pnpm --filter @corridor/integrations smoke:borderconnect`) and record the observed receive envelope in the BorderConnect README under "Confirmed live"; adjust `normaliseReceiveBody` and its test if the envelope differs from every normalised shape. Record any `DATA_ERROR` field the test trip trips over and fix the mapper (this is expected to surface 1–3 field-format issues).
- [ ] **Step 3: Docs/env edits** above. **Step 4: Full verification:** `pnpm typecheck && pnpm lint && pnpm test`, `source .env.local && pnpm exec supabase db reset && pnpm db:seed && pnpm --filter @corridor/db verify:mirror && pnpm db:lint && pnpm test:integration`, Playwright on :3100. **Step 5: Commit** `chore(customs): BorderConnect smoke script, env and security-review updates`.

---

## Verification (end to end)

1. **Offline (no credentials):** `pnpm dev` (worktree, :3100); Settings → Integrations → ACE mode BorderConnect; Settings → Organization → company key `c-test`; create an ACE movement with one PAPS shipment (province of loading, packaging unit, structured shipper/consignee address filled) → Transmit → submission row `mode = border_connect`, movement `sent`; `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3100/api/jobs/borderconnect-drain` → movement `accepted`, readiness panel shows entries pending; repeat with a control number ending in `R` → `rejected` with the validation message; `H` → `held`. `customs_inbox` rows all have `processed_at` and `movement_id`.
2. **Missing-field path:** blank the province of loading → Transmit shows the 422 message listing the field; nothing is sent (no `customs_submissions` row with `acknowledged`).
3. **Live (SP account, autoSend:false):** `scripts/borderconnect-smoke.ts` → `API_RESPONSE` `IMPORTED` (or `DATA_ERROR` with the fields to fix) and the raw receive envelope printed.
4. **Suites:** `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration` green; Playwright movements + settings specs green on :3100.
5. **Security review:** every new `withServiceRole` call site listed in `docs/security-review.md`; `customs_inbox` cross-tenant test green; `background_jobs` policy test green.

## Open risks carried into implementation

1. `GET /api/receive` envelope — settled by Task 16; the transport normalises four shapes until then.
2. ACI amendments: `operation: UPDATE` + `autoSend` cannot carry `tripAmendmentReasonCode` (only `ACI_SEND_REQUEST type AMEND` can) — `amend()` for ACI is marked experimental in the README; confirm with BorderConnect whether a reason code is required, and if so switch ACI amend to `UPDATE, autoSend:false` + `ACI_SEND_REQUEST { type: "AMEND", tripAmendmentReasonCode }` using `movement_amendments.reason_code` (0022).
3. `time-zones.json`, `trailer-types.json`, `travel-document-types.json`, `ca/rns` release codes — fetched and vendored during Tasks 5/11; if a Corridor code has no BorderConnect equivalent the mapper 422s.
4. Hazmat emergency contact and in-bond `irsNumber`/`fda` are not captured → in-bond and hazmat ACE shipments 422 in v1 (follow-up: two registry fields).
5. Plain non-PARS ACI "regular" shipments have no confirmed BorderConnect `shipmentType` → 422 until confirmed.
6. Whether an open WebSocket diverts messages from the HTTP queue — verify before deploying the listener.
