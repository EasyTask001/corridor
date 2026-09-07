# Corridor — Avaal parity plan (closes gap items 1–25)

## Context

On 2026-09-06 we walked every module of Avaal Electronic Manifest (the incumbent ACE/ACI
e-manifest product used by Pathfinder Trans) and compared it with Corridor. The gap analysis
(`/tmp/claude-1000/-home-hsthind-Documents-Corridor/f047cac8-711a-4ba2-9cc3-dc801f71563e/scratchpad/corridor-vs-avaal-gap-analysis.md`)
lists 25 gaps. Corridor's AI layer is ahead of Avaal, but its customs data model is too thin for a
real carrier to file with CBP or CBSA: no PAPS/PARS or shipment entity, single driver/trailer per
manifest, 12 hard-coded ports, one SCAC per org, mock-only transmission, no driver-sheet PDFs, no
in-bond, no bulk import, no exports. This plan closes all 25 gaps so Corridor can replace Avaal.

Decisions already made by the user:
- Live filing goes through a **certified EDI gateway's REST API** behind the existing
  `CustomsClient` interface (no direct X12/EDIFACT). Vendor mapping isolated in one small file.
- Public PAPS/PARS lookup is **gated** (carrier code + control number), returns status/port/entry
  number/timestamps only, rate-limited.
- **No production data** — schema may be restructured freely; seed is updated in each task.
- Outbound channels: **Resend email + Twilio SMS** (mock mode when env absent). No fax.

Out of scope: Avaal's TCP module (could not be verified — it terminated the session; it is a
records list of owner-operators / terminals, not a customs flow).

## Global Constraints

All Global Constraints of `docs/plans/2026-09-06-gap-closure.md` apply verbatim (RLS boundary,
no secrets in browser, mock-friendly providers, migrations are source of truth + Drizzle mirror,
verification bar, commit style, fixed stack versions, code layout). Additions:

- **Plan document:** save this plan as `docs/plans/2026-09-06-avaal-parity.md` in the first
  commit. Migrations start at **0018** (0012–0017 already landed on main).
- **Branch:** all work happens on branch `avaal-parity` in a git worktree; another session is
  committing to `main` concurrently. Never commit to `main`. Rebase onto `main` before the final
  whole-branch review and re-run the SQL verification after the rebase.
- **Already on main (use directly, no fallbacks):** Vault credentials via
  `read_integration_secret` (migration 0012, `packages/api/src/services/customs.ts`),
  `packages/api/src/infra/{ratelimit,redis,permission-cache}.ts`, the Expo driver app in
  `apps/mobile` (a tRPC consumer of `movement.list/get` under `movement.read_assigned` — when a
  task changes those outputs, update the mobile screens in the same task; `pnpm typecheck`
  covers it), and `background_jobs_insert` (migrations 0008/0016) which allow-lists job types:
  **every new `JobType` must be added to that policy in the same migration** with the
  permission of its enqueuer (worker-enqueued types use `false` for `authenticated`).
- **Repo schema rules (`CLAUDE.md`, `CONTRIBUTING.md` → Schema design) bind every migration:**
  extend before you add (same grain → columns); every `create table` carries a "Why a new
  table" header paragraph (grain, existing tables considered, why each does not fit — see
  `0013_usage_billing.sql`); no `settings jsonb` keys or key/value bags to dodge a migration —
  `jsonb` only for provider payloads, free-form metadata and addresses (which follow the
  existing `partners.address` precedent); structured repeating data gets a child table
  (`commodity_hazmat`, `equipment_plates`) not a jsonb array; denormalised copies
  (`shipments.control_number`) need a trigger and an integration test; verification adds
  `pnpm db:lint`.
- **Every new tenant table:** `organization_id`, `enable row level security`, policies
  `<table>_<verb>` via `has_permission(organization_id, key)`, grants,
  `<table>_organization_id_idx`, Drizzle mirror, `pnpm --filter @corridor/db verify:mirror`
  clean after `pnpm db:reset`, and an "Org A sees zero Org B rows" test in
  `packages/db/src/<area>.integration.test.ts` (pattern: `withRls` in `rls.integration.test.ts`).
  Global reference tables (ports, equipment types, carrier notices) have no `organization_id`
  and a `select ... to authenticated` (plus `anon` where the public lookup needs it) policy.
- **New permission keys** go in `packages/domain/src/permission.ts`, then
  `pnpm --filter @corridor/db seed:generate`. Grants: owner/admin all; dispatcher gets
  `shipment.*`, `inbond.*`, `import.run`; compliance_officer and read_only get `*.read`;
  driver_portal nothing new.
- **Enums** stay `text check (...)` in SQL + `text("c", { enum })` in Drizzle + zod enum in
  `packages/domain` (no pgEnum). Canonical lists live in `packages/domain`.
- **Workspace split:** the first task touching
  `apps/web/src/components/movement/movement-workspace.tsx` (Task 2) splits it into
  `components/movement/steps/{trip,truck,crew,shipments,trailers,seals,review}-step.tsx`,
  `steps/assign-panel.tsx` (today's `assignPanel` helper) and `workspace-context.tsx`
  (movement, `refresh`, `editable`, mutations via `useMovementMutations()`), leaving
  `movement-workspace.tsx` as the shell (STEPS, stepper, `useMovementRealtime`). Later tasks
  edit only their step file.
- **Replacing a trigger or function** (`movements_guard()`, `movement_children_guard()`,
  `shipments_control_number()`, `create_organization_with_owner()`, …): always `create or replace`
  from the **latest** prior definition — `grep -n "function public.<name>" supabase/migrations/*.sql`
  and take the highest-numbered file (e.g. `movements_guard()` lives in 0008, revised again in 0018) —
  never from the migration that first created it. Add an integration test for a protection the
  replaced body must keep.
- **Env vars** added to `.env.example` and `turbo.json` `globalEnv` in the task introducing them.
- **Manifest payload** (`packages/integrations/src/customs/types.ts` `ManifestPayload`) is
  extended in place; `buildManifest` in `manifest.ts` stays the single builder.

Gap → task map: 7,10→T1 · 2,3,4→T2 · 5→T3 · 6→T4 · 8→T5 · 1,16→T6 · 9→T7 · 14,19→T8 ·
11,12→T9 · 2(RNS),17→T10 · 13→T11 · 15,18,20→T12 · 21,22,23,24→T13 · 25→T14.

Ordering: T1→T2→T3→T4→T5→T6 strictly sequential (each migration alters the previous one's
tables; steps are added one per task after the T2 split). T7 after T4; T8 after T7. T9/T10/T11
after T6 and mutually independent. T12/T13/T14 independent, after T7.

---

## Task 1: Port master and multi-carrier codes (gaps 7, 10)

**Migration:** `supabase/migrations/0018_ports_and_carrier_codes.sql`
**Files:** `packages/db/src/schema/reference.ts` (new), `packages/db/data/ports/*.csv` (new),
`packages/db/scripts/import-ports.ts` (new), `packages/db/package.json`,
`packages/domain/src/reference.ts` (new), `packages/domain/src/{movement.ts,movement-inputs.ts,organization.ts}`,
`packages/api/src/router/{reference.ts (new),organization.ts,movement.ts,_app.ts}`,
`packages/api/src/services/customs.ts`, `packages/integrations/src/customs/{types,manifest}.ts`,
`apps/web/src/components/port-picker.tsx` (new),
`apps/web/src/app/(app)/settings/organization/{organization-form,carrier-codes-panel}.tsx`,
`packages/db/scripts/seed.ts`, `packages/db/src/reference.integration.test.ts` (new).

1. SQL `public.ports` (global): `id uuid pk default gen_random_uuid()`, `regime text check in
   ('ACE','ACI')`, `kind text check in ('port_of_entry','in_bond_destination','cbsa_office',
   'firms','sublocation')`, `code text not null`, `name text not null`, `state_province text`,
   `country text check in ('US','CA')`, `parent_code text` (sublocation → office, FIRMS → port),
   `active boolean not null default true`; `unique (regime, kind, code)`; `ports_search_idx`
   gin on `to_tsvector('simple', code || ' ' || name)`. RLS on; `ports_select for select to
   authenticated, anon using (active)`. Insert the 12 existing `CROSSING_POINTS` inline so
   `db reset` alone works.
2. SQL `public.organization_carrier_codes`: `id`, `organization_id`, `regime`, `code text check
   (code ~ '^[A-Z0-9]{2,4}$')`, `label text`, `is_default boolean not null default false`,
   `status text check in ('active','inactive') default 'active'`, `created_at`;
   `unique (organization_id, regime, code)`; partial unique
   `organization_carrier_codes_default_unique (organization_id, regime) where is_default`.
   RLS via `organization.read` / `organization.manage`. **Keep** `organizations.scac_code` and
   `canadian_carrier_code` (they remain the onboarding inputs); backfill one default row per
   regime from them; extend `create_organization_with_owner(...)` to insert those default rows.
   Add `organizations.filer_code text check (filer_code ~ '^[A-Z0-9]{3}$')`.
3. `movements`: add `carrier_code text` (snapshot of the code, not an FK — codes are stable
   identifiers and appear in control numbers) and `port_id uuid references public.ports(id)`;
   backfill `port_id` from `crossing_point->>'code'` joined on `ports.code`, then drop
   `crossing_point`. Update the frozen-column list in `movements_guard()` (latest body is in
   `0008_security_hardening.sql`) to `port_id`, `carrier_code`.
4. Drizzle: new `reference.ts` (`ports`, `organizationCarrierCodes`); update `core.ts`,
   `movements.ts`; export from `schema/index.ts`.
5. `import-ports.ts`: parses `packages/db/data/ports/{us_ports,cbsa_offices,in_bond_destinations,firms,cbsa_sublocations}.csv`
   (header `regime,kind,code,name,state_province,country,parent_code`, hand-rolled split — no
   quoted commas in this data) and upserts `on conflict (regime, kind, code) do update`.
   Script `"ports:import": "tsx scripts/import-ports.ts"`; root `db:seed` runs it before
   `seed.ts`. Ship the full CBP port-of-entry code list, CBSA office list and in-bond
   destination list; FIRMS and sublocations start with entries for the demo ports.
6. Domain: `reference.ts` exports `portKind`, `portSchema`, `carrierCodeInput { regime, code,
   label?, isDefault }`. Delete `CROSSING_POINTS` and `crossingPoint` zod; `movementPatch` and
   `createMovementInput` take `portId: uuid` and `carrierCode: z.string().regex(...)` (server
   defaults to the regime's default code when omitted).
7. API: `reference.ports.search({ regime, kind, q, limit })` (`orgProcedure`),
   `organization.carrierCodes.list/upsert/remove/setDefault` (`organization.manage`,
   `writeAudit`). `manifestFor`/`buildManifest`: `carrier.code`, `carrier.filerCode`,
   `trip.portOfEntry` = `ports.code`. `movement.list` filter `portId`; `movement.options`
   returns carrier codes instead of crossing points. `reporting` `crossing` dimension joins
   `ports.name`.
8. UI: `PortPicker` (debounced search, renders `code — name (state)`), used by the trip step
   and the movements list filter. `carrier-codes-panel.tsx` on the organization settings page.
9. Seed: Pathfinder ACE `PFTR` (default) + `PFTS`; ACI `7ELU` (default); Northbound `NBFL`.
   Movements get `port_id` + `carrier_code`. Update `e2e/movements.spec.ts` for the picker.

**Acceptance:** `pnpm exec supabase db reset && pnpm db:seed`; `pnpm --filter @corridor/db
verify:mirror`; `pnpm --filter @corridor/db test:integration` (ports readable by both orgs,
carrier codes isolated); `pnpm typecheck && pnpm lint && pnpm test`.

---

## Task 2: Shipments as a first-class entity; `cargo` → `commodities`; workspace split (gaps 2, 3, 4)

**Migration:** `supabase/migrations/0019_shipments.sql`
**Files:** `packages/db/src/schema/movements.ts`,
`packages/domain/src/{shipment.ts (new),movement.ts,movement-inputs.ts,movement-validation.ts,permission.ts}`,
`packages/api/src/router/{shipment.ts (new),movement.ts,documents.ts,reporting.ts,_app.ts}`,
`packages/api/src/services/{movements.ts,shipments.ts (new),customs.ts,predictive.ts,risk.ts,documents.ts}`,
`packages/integrations/src/customs/{types,manifest}.ts`,
`apps/web/src/components/movement/**` (split per Global Constraints),
`apps/web/src/components/shipment/{shipment-form,commodity-form,hazmat-fields}.tsx` (new),
`apps/web/src/app/(app)/shipments/{page.tsx,[shipmentId]/page.tsx}` (new),
`apps/web/src/app/(app)/documents/[documentId]/review-workspace.tsx`,
`apps/web/src/components/app-shell.tsx`, seed, `packages/db/src/shipments.integration.test.ts` (new).

1. SQL `public.shipments`: `id`, `organization_id`, `regime`, `movement_id uuid null references
   movements(id) on delete set null`, `carrier_code text not null`, `shipment_type text check in
   ('regular_bill','section_321','goods_astray','free_of_duty_7523','free_return_us_goods_3311',
   'unaccounted_articles_3299','in_bond')`, `cargo_type text check in
   ('regular','consolidated','csa','a49','e29b')`, check `(regime='ACE' and shipment_type is
   not null and cargo_type is null) or (regime='ACI' and cargo_type is not null and
   shipment_type is null)`; `control_reference text not null check (~ '^[A-Z0-9]{4,20}$')`
   (the PAPS/PARS/bill part); `control_number text not null` filled by trigger
   `shipments_control_number()` = `carrier_code || control_reference` (Task 8 adds the
   "include PARS" rule); `unique (organization_id, control_number)`; `is_pars boolean default
   false`; `entry_number text`, `entry_port_id uuid references ports(id)`;
   `in_bond_entry_type text check in ('IT','TE','IE')`, `in_bond_destination_port_id`,
   `in_bond_number text`; `shipper_id`, `consignee_id` → partners (restrict); ACI:
   `destination_port_id`, `sublocation_port_id`, `loading_country`, `loading_province`,
   `loading_city`, `delivery_address jsonb`, `consignee_business_number text`;
   `status text check in ('draft','sent','accepted','rejected','entry_on_file','released',
   'held','arrived','cancelled') default 'draft'`; `entry_on_file_at`, `released_at`,
   `arrived_at`, `cancelled_at`; `import_batch_id uuid` (FK added in Task 11);
   `source_document_id`; `notes`; timestamps. Indexes `shipments_org_status_idx`,
   `shipments_movement_idx (movement_id) where movement_id is not null`,
   `shipments_control_search_idx` gin. Trigger `shipments_guard()`: regime must equal the
   movement's; content edits rejected when the attached movement is not in
   `EDITABLE_STATUSES`; `movement_id` may change only while the shipment is `draft|rejected`.
2. `alter table public.cargo rename to commodities`; drop `movement_id`, `shipper_id`,
   `consignee_id`, `entry_number`, `in_bond_number`; add `shipment_id uuid not null references
   shipments(id) on delete cascade`; rename `piece_count` → `quantity`; add `quantity_unit text`
   (domain `CBP_QUANTITY_UNITS`, the Avaal list: Bag, Bale, Barrel, Box, Bundle, Carton, Case,
   Coil, Crate, Drum, Pallet, Piece, Roll, …), `weight_unit text check in ('KG','LB') default
   'KG'` (keep `weight_kg` canonical, store entered unit), `marks_and_numbers text`,
   `is_consolidated boolean default false`. New child table `public.commodity_hazmat`
   (`id`, `organization_id`, `commodity_id` cascade, `position int check (position between 1 and 3)`,
   `un_code text check (~ '^UN\\d{4}$')`, `description`, `emergency_contact`, `emergency_phone`;
   `unique (commodity_id, position)`). Rename indexes/policies to `commodities_*`. `movement_children_guard` covers `shipments` and
   `commodities` via the shipment's movement. `movement_events` gains `shipment_id uuid null`.
3. Permissions `shipment.read`, `shipment.write` (+ `seed:generate`).
4. Domain `shipment.ts`: `aceShipmentType`, `aciCargoType`, `shipmentStatus`,
   `SHIPMENT_TRANSITIONS` (draft→sent→accepted→entry_on_file→released→arrived; held/rejected/
   cancelled as in movements), `shipmentInput` (`z.discriminatedUnion("regime", …)`),
   `shipmentPatch`, `commodityInput` (`hazmat: z.array(hazmatEntry).max(3)`, written to `commodity_hazmat`, with
   `hazmatEntry { unCode: /^UN\d{4}$/, description, emergencyContact, emergencyPhone }`),
   `shipmentListInput { regime?, status?, unassignedOnly?, q?, limit, offset }`,
   `assignShipmentsInput { movementId, shipmentIds: uuid[] }`. `validateForTransmit` takes
   `shipments[] { shipmentType|cargoType, shipper, consignee, entryNumber, inBond…, commodities[] }`;
   `ValidationIssue.step` gains `"commodity"`. Blocking: no shipments (unless `is_empty`, Task 4),
   missing shipper/consignee, `in_bond` without entry type + destination, ACI `consolidated`
   with < 2 commodities, commodity without quantity unit. Warning: ACE shipper not CA /
   consignee not US (reverse for ACI). Update `movement-validation.test.ts`.
5. API `shipment` router: `list`, `get`, `create`, `update`, `remove` (draft only),
   `commodities.upsert/remove`, `assign`, `unassign`, `listForAssign({ movementId, q })` (same
   regime, `movement_id is null`, draft). Remove `movement.cargo.*`. `loadFull` returns
   `shipments[] { …, commodities[] }`. `buildManifest` maps `shipments[] { controlNumber,
   shipmentType|cargoType, entryNumber, entryPort, inBond, shipper{name,address},
   consignee{…}, commodities[] { description, hsCode, quantity, quantityUnit, weightKg,
   marksAndNumbers, hazmat[], countryOfOrigin, value } }`. `documents.applyExtraction` creates
   a draft shipment + commodities linked via `source_document_id`. Update `risk.ts`,
   `predictive.ts`, `reporting.ts` joins (`commodities → shipments → movements`).
6. UI: perform the workspace split. `shipments-step.tsx`: attached shipments table (expand →
   commodities), "Add shipment" (inline `ShipmentForm`), "Assign existing" dialog
   (`listForAssign` + checkboxes). `/shipments` list (server component; filters regime/status/
   unassigned) and `/shipments/[shipmentId]` detail with `CommodityForm` + `HazmatFields`.
   Nav "Shipments" (`shipment.read`). `review-workspace.tsx` "apply" now creates a shipment.
7. Seed: `seedMovement.cargo` → `shipments: [{ type, controlReference, shipper, consignee,
   commodities }]`; add 3 unassigned shipments (2 ACE, 1 ACI `isPars`). `e2e/movements.spec.ts`
   updated; new `e2e/shipments.spec.ts` (create → assign → visible in workspace).

**Acceptance:** reset+seed; `verify:mirror`; integration (shipments/commodities RLS, control
number trigger, regime mismatch rejected, edit blocked when movement is `sent`); unit;
Playwright `movements.spec.ts`, `shipments.spec.ts`; typecheck/lint.

---

## Task 3: Multi-person crew, roles, travel documents (gap 5)

**Migration:** `supabase/migrations/0020_crew_and_travel_documents.sql`
**Files:** `packages/db/src/schema/{movements,registry}.ts`,
`packages/domain/src/{registry.ts,movement-inputs.ts,movement-validation.ts,compliance.ts}`,
`packages/api/src/router/{movement,party}.ts`,
`packages/api/src/services/{movements,compliance,customs,predictive}.ts`,
`packages/integrations/src/customs/{types,manifest}.ts`,
`apps/web/src/components/registry/{fields.ts,driver-documents-panel.tsx (new)}`,
`apps/web/src/components/movement/steps/crew-step.tsx`, seed,
`packages/db/src/registry.integration.test.ts`.

1. SQL `public.movement_crew`: `id`, `organization_id`, `movement_id` cascade, `driver_id
   references drivers(id) on delete restrict`, `role text check in ('person_in_charge',
   'crew_member','passenger')`, `position int`; `unique (movement_id, driver_id)`; partial
   unique `movement_crew_pic_unique (movement_id) where role='person_in_charge'`. Backfill
   from `movements.driver_id` as PIC, then drop `movements.driver_id` (+ partial index, guard
   column). Add to `movement_children_guard`.
2. `drivers`: add `person_type text check in ('driver','passenger') default 'driver'`,
   `gender text check in ('M','F','X')`, `hazmat_endorsement boolean default false`,
   `us_address jsonb`; check `person_type='passenger' or license_number is not null`.
3. SQL `public.driver_documents`: `id`, `organization_id`, `driver_id` cascade,
   `document_type text check in ('passport','us_passport_card','fast','nexus','sentri',
   'enhanced_drivers_license','permanent_resident_card','us_alien_registration','visa_immigrant',
   'visa_non_immigrant','laser_visa_bcc','military_id','merchant_mariner','native_american_inac',
   'dhs_reentry_permit','dhs_refugee_travel','birth_certificate','citizenship_card',
   'certificate_of_naturalization','other')` (the Avaal/CBP list), `document_number`,
   `issuing_country`, `issuing_state`, `issued_on date`, `expires_on date`, `is_primary boolean`;
   `unique (driver_id, document_type, document_number)`. Migrate `drivers.fast_card_number/
   fast_card_expiry` into `fast` rows, then drop those columns. RLS `driver.read`/`driver.write`.
4. Compliance scanner: the FAST expiry source becomes `driver_documents.expires_on` (entity
   `driver`, `field = document_type`); keep dedupe-key semantics.
5. Domain: `driverInput` + new fields; `driverDocumentInput`; `crewInput { movementId, driverId,
   role }`, `crewRemoveInput`, `crewSetRoleInput`. `validateForTransmit` takes `crew[] { role,
   personType, licenseExpiry, status, citizenship, documents[] }`: blocking — no PIC, PIC not a
   driver, any driver with missing/expired license, any passenger without a travel document;
   warning — expired FAST/NEXUS, ACE passenger without `us_address` when consignee is non-US.
6. API: `movement.crew.add/remove/setRole`; `party.drivers.documents.list/upsert/remove`;
   `movement.list` `driverId` filter joins `movement_crew`; the `movement.read_assigned`
   driver-portal scope uses `exists (select 1 from movement_crew where driver_id = my driver)`.
   Manifest `crew[]` carries `role`, `gender`, `documents[]`, `hazmatEndorsement`.
7. UI: `crew-step.tsx` multi-select with role dropdown (exactly one PIC enforced client-side
   too); driver registry gets a "Travel documents" tab; `fields.ts` adds person type, gender,
   hazmat endorsement, US address.
8. Seed: Reyes gets passport + FAST; one movement with two crew; one passenger record.
   `e2e/registries.spec.ts` adds a document.

**Acceptance:** reset+seed; `verify:mirror`; integration (crew/documents RLS, PIC uniqueness,
driver_portal sees only assigned movements); unit; Playwright `registries.spec.ts`,
`movements.spec.ts`; typecheck/lint.

---

## Task 4: Multi-trailer, per-trailer seals, truck and trailer detail (gap 6)

**Migration:** `supabase/migrations/0021_equipment.sql`
**Files:** `packages/db/src/schema/{movements,registry,reference}.ts`,
`packages/domain/src/{registry.ts,reference.ts,movement-inputs.ts,movement-validation.ts}`,
`packages/api/src/router/{movement,party,reference}.ts`,
`packages/api/src/services/{movements,customs,predictive,compliance}.ts`,
`packages/integrations/src/customs/manifest.ts`, `apps/web/src/components/registry/fields.ts`,
`apps/web/src/components/movement/steps/{trailers-step,seals-step}.tsx`, seed, integration tests.

1. SQL `public.movement_trailers` (`id`, `organization_id`, `movement_id` cascade, `trailer_id`
   restrict, `position int`, `unique (movement_id, trailer_id)`). Backfill from
   `movements.trailer_id`, drop it (+ index, guard, `compliance.ts` `entityColumn` map → join).
   `seals`: drop `trailer_id`; add `movement_trailer_id uuid null references
   movement_trailers(id) on delete cascade` (null = truck seal); trigger `seals_limit()` raises
   at 4 seals per trailer / 1 per truck. `movements.is_empty boolean not null default false`.
2. `public.equipment_types` (global: `code text pk`, `label`, `regime_scope text check in
   ('ACE','ACI','both')`) seeded inline with the CBP equipment list captured from Avaal's
   trailer-type dropdown; `trailers.trailer_type` becomes `references equipment_types(code)`,
   mapping old enum values (`dry_van→TL`, `reefer→RT`, `flatbed→FB`, `tanker→TN`,
   `container_chassis→CH`, `step_deck→SD`, `other→OT`).
3. New child table `public.equipment_plates` (`id`, `organization_id`, `truck_id null`,
   `trailer_id null` (check exactly one), `plate_number`, `jurisdiction`, `position int check
   (position between 1 and 4)`, `unique (truck_id, position)`, `unique (trailer_id, position)`);
   the primary plate stays on `trucks/trailers.plate_number/plate_jurisdiction` and
   `equipment_plates` holds the extra ones (zod max 3 extra). `trucks` add `dot_number`, `hazmat_capable boolean`,
   `insurance_company`, `insurance_amount numeric(12,2)`, `insurance_year int`.
4. Domain: `truckInput`/`trailerInput` updated; `equipmentType` zod from `EQUIPMENT_TYPES`;
   `trailerAddInput`, `sealAddInput { movementId, movementTrailerId?, sealNumber, sealType }`.
   Validation: each trailer active + registration current; warning trailer without seal;
   blocking when `is_empty=false` and no trailers and no shipments.
5. API: `movement.trailers.add/remove/reorder`; `movement.seals.add` takes
   `movementTrailerId`; `reference.equipmentTypes.list`. Manifest `equipment[]` per trailer
   with `seals[]`; `conveyance.seals[]`, `conveyance.plates[]`, `insurance`, `dotNumber`.
   Predictive-assembly `MovementSuggestionPayload`: `driverId/trailerId` → `crew[]/trailerIds[]`.
6. UI: `trailers-step.tsx` (multi-assign, ordered), `seals-step.tsx` (grouped by trailer +
   truck, 4-slot rows). Registry: add `FieldType "repeater"` to `FieldDef` for extra plates;
   insurance group; equipment type select from `reference.equipmentTypes.list`.
7. Seed: one movement with two trailers, seals on each; TR-503 → `RT`.

**Acceptance:** reset+seed; `verify:mirror`; integration (seal limit trigger, movement_trailers
RLS); unit; Playwright `movements.spec.ts`; typecheck/lint.

---

## Task 5: Manifest flags, CBSA amendment reason codes, customs event vocabulary (gap 8)

**Migration:** `supabase/migrations/0022_manifest_flags_and_customs_events.sql`
**Files:** `packages/db/src/schema/movements.ts`,
`packages/domain/src/{movement.ts,movement-inputs.ts,shipment.ts,movement-validation.ts,customs-events.ts (new)}`,
`packages/api/src/router/movement.ts`, `packages/api/src/services/movements.ts`,
`packages/integrations/src/customs/{types,manifest,mock}.ts`,
`apps/web/src/components/movement/{steps/trip-step.tsx,steps/review-step.tsx,timeline.tsx}`, unit tests.

1. `movements`: `iit_indicator text check in ('none','iit_carrier_bond','iit_importer_bond')
   default 'none'` (Avaal's three IIT options); ACI booleans `aci_lvs`, `aci_postal`,
   `aci_flying_truck`, `aci_in_transit`, `aci_iit` (default false; check all false when
   `regime='ACE'`). `is_empty` (Task 4) = "Empty Trailer" (ACE) / "Empty Trip" (ACI).
2. `movement_amendments`: add `shipment_id uuid null`, `reason_code text`; domain
   `CBSA_AMENDMENT_REASON_CODES` = the CBSA ECCRD amendment reason list; initial entries are
   the labels captured from Avaal ("Duplicate CCD, need to cancel one", "Change request
   delayed by client systems outage", "Amendment not elsewhere specified", "Entire shipment not
   laden…", "Clerical error when keying conveyance data", …) with their CBSA codes; required
   when `regime='ACI'` (zod + trigger).
3. `movement_events.event_type` gains `'customs_event'`; payload `customsEventPayload { code,
   label, referenceNumber?, entryNumber?, entryPortCode?, shipmentControlNumber?, raw }`;
   `CUSTOMS_EVENT_CODES` in `customs-events.ts`: `sending`, `preliminary_check_passed`,
   `accepted`, `rejected`, `entry_on_file`, `arrival_recorded`, `released`, `held`,
   `entered_and_released`, `cancelled`. `CustomsDecisionMessage` gains `events[]` and
   `shipments[] { controlNumber, status, entryNumber?, entryPortCode? }`;
   `applyCustomsDecision` writes one `customs_event` per event, updates
   `shipments.entry_number/entry_port_id/status` on `entry_on_file`, cascades movement status
   to shipments. Mock client emits the Avaal sequence (`sending → preliminary_check_passed →
   accepted → entry_on_file per shipment → released`, `HOLD`/`REJECT` variants).
4. Domain/UI: `movementPatch` gains the flags; `amendmentInput` gains `reasonCode`,
   `shipmentId?`; `trip-step.tsx` regime-aware toggles; `review-step.tsx` amend dialog with
   reason select; `timeline.tsx` renders `customs_event` rows with label + entry number.
5. Validation: `is_empty` with shipments → blocking; `aci_in_transit` requires
   `destination_port_id` on every shipment.

**Acceptance:** unit (`movement.test.ts`, `mock.test.ts` for the event sequence); integration
(amendment reason trigger); Playwright `movements.spec.ts` (submit → timeline shows "Entry on
file"); typecheck/lint.

---

## Task 6: Gateway customs client, inbound webhook, status polling, customs notices (gaps 1, 16)

**Migration:** `supabase/migrations/0023_customs_gateway.sql`
**Files:** `packages/integrations/src/customs/{types.ts,index.ts,gateway/client.ts,gateway/transport.ts,gateway/mapping.ts,gateway/fixtures/*.json,gateway/README.md,gateway/client.test.ts}`,
`packages/api/src/services/{customs.ts,jobs.ts,notices.ts (new)}`,
`packages/api/src/router/{movement,integrations,notifications}.ts`,
`packages/domain/src/notification.ts`, `apps/web/src/app/api/webhooks/customs/route.ts` (new),
`apps/web/src/app/(app)/settings/integrations/integrations-panel.tsx`, `vercel.json`,
`packages/db/src/schema/{integrations,notifications}.ts`, `.env.example`, `turbo.json`.

1. `CustomsClient` gains `amend(manifest, referenceNumber)`, `cancel(referenceNumber, reason)`,
   `fetchStatus(referenceNumber) → CustomsStatusMessage { status, events[], shipments[] }`,
   `fetchNotices(since) → CarrierNotice[]`, `parseInbound(rawBody, headers, secret) →
   InboundMessage | null`. Mock implements all.
2. `gateway/transport.ts` (the only vendor-specific file, ≤120 lines): `GatewayTransport
   { post(path, body), get(path) }` with base URL, `Authorization: Bearer <apiKey>`, 30 s
   timeout, `CustomsTransportError` on non-2xx (retryable for 429/5xx). `gateway/mapping.ts`:
   `toGatewayManifest(ManifestPayload)` / `fromGatewayStatus(json)` against a provider-neutral
   contract `POST /manifests`, `POST /manifests/{ref}/amendments`, `POST /manifests/{ref}/cancel`,
   `GET /manifests/{ref}`, `GET /notices?since=`. `gateway/client.ts`:
   `createGatewayCustomsClient({ provider, environment, baseUrl, apiKey, transport? })`.
   `createCustomsClient` selects by `mode`: `mock` (today) or `gateway`; in `gateway` mode with
   no base URL/API key it uses `FixtureTransport` replaying
   `gateway/fixtures/{ace,aci}-{accepted,held,rejected}.json` keyed by the first control
   number's suffix (documented in `gateway/README.md`).
3. `customsClientFor`: SQL adds columns `integration_configs.mode text not null check (mode in
   ('mock','gateway')) default 'mock'`, `base_url text`, `last_polled_at timestamptz`; API key via
   `read_integration_secret(credentials_ref)` (already on main) else env
   `CUSTOMS_GATEWAY_API_KEY`; base URL `base_url` else `CUSTOMS_GATEWAY_BASE_URL`. new tenant table `public.customs_submissions`
   (`organization_id`, `movement_id`, `kind text check in ('original','amendment','cancel',
   'in_bond')`, `reference_number`, `correlation_id`, `status`, `request jsonb`,
   `response jsonb`, `created_at`; index `(reference_number)`) — audit of every outbound call.
4. Jobs: `JobType` gains `"customs.poll_status"` (gateway mode: enqueued after transmit, re-
   enqueued every 2 min up to 48 h until terminal; mock keeps `customs.decide`) and
   `"customs.notices_sync"` (hourly cron entry in `vercel.json` → `notices.ts` upserts global
   `public.carrier_notices` (`id`, `provider`, `external_id unique`, `severity text check in
   ('info','warning','critical')`, `title`, `body`, `starts_at`, `ends_at`, `published_at`), then
   `notifyOrganization` for each org with an enabled config using new event type
   `customs.notice` → permission `movement.read`). Mock `fetchNotices` returns one fixture
   notice so the flow is testable offline.
5. Webhook `POST /api/webhooks/customs`: HMAC-SHA256 over the raw body with
   `CUSTOMS_GATEWAY_WEBHOOK_SECRET`, `timingSafeEqual`; resolves `customs_submissions.
   reference_number` → org/movement under `withServiceRole`; calls `applyCustomsDecision`;
   idempotent on `(reference_number, event id)` via `integration_events.correlation_id`;
   200 `{ applied }`, 401 on bad signature. `/api/*` is already public in `proxy.ts`.
6. `movement.amend` / `movement.cancel` (from `sent|accepted|held`) call `client.amend` /
   `client.cancel` and record submissions. Integrations panel: `mode`/`base_url` fields,
   "Test connection" (`integrations.testCustoms` → `GET /manifests/ping` or fixture).
7. Env: `CUSTOMS_GATEWAY_BASE_URL`, `CUSTOMS_GATEWAY_API_KEY`, `CUSTOMS_GATEWAY_WEBHOOK_SECRET`.
   Tests: `gateway/client.test.ts` with an in-memory transport (submit → poll → held →
   released; 429 retry; signature verify); `customs.integration.test.ts` (submissions RLS).

**Acceptance:** unit; integration; typecheck/lint; with no env set the Playwright suite is
unchanged (mock mode); `curl -X POST localhost:3000/api/webhooks/customs -d '{}'` → 401.

---

## Task 7: Driver sheet and manifest summary PDFs (gap 9)

**Migration:** `supabase/migrations/0024_generated_documents.sql`
**Files:** `packages/pdf/{package.json,tsconfig.json,src/index.ts,src/render.ts,src/render.test.ts,src/templates/{driver-sheet,blank-driver-sheet,manifest-summary,table-report}.tsx}` (new `@corridor/pdf`),
`packages/api/src/services/pdf.ts` (new), `packages/api/src/router/pdf.ts` (new), `_app.ts`,
`apps/web/src/app/api/pdf/[id]/route.ts` (new), `apps/web/src/components/movement/print-menu.tsx` (new),
`apps/web/src/components/movement/steps/review-step.tsx`, `apps/web/src/app/(app)/movements/page.tsx`,
`packages/db/src/schema/documents.ts`, `packages/domain/src/organization.ts`, `pnpm-workspace.yaml`.

1. Library `@react-pdf/renderer` (v4, React 19 compatible; `renderToBuffer` in Node route
   handlers; templates are components). `services/pdf.ts` is server-only.
2. SQL `public.generated_documents`: `id`, `organization_id`, `movement_id null`, `kind text
   check in ('driver_sheet','blank_driver_sheet','manifest_summary','report',
   'registry_export')`, `storage_path`, `content_type`, `byte_size`, `metadata jsonb`,
   `created_by`, `created_at`. RLS `movement.read` (`report.read` for reports/exports).
   `organizations.simple_driver_sheet boolean not null default false`.
3. `services/pdf.ts`: `generateForMovement(tx, actor, { movementId, kind })` renders with
   `loadFull` + org, uploads to bucket `documents` at
   `<org>/generated/<movementId>/<kind>-<timestamp>.pdf` (add `generatedPathFor` beside
   `storagePathFor`), inserts the row, returns `{ id, signedUrl }`.
   `generateBlankSheets({ fromTrip, toTrip, driverName?, coDriverName? })`. Templates: driver
   sheet (carrier header, trip/port/ETA, crew, equipment + seals, shipments with control and
   entry numbers, signature line; `simple` variant omits commodities); manifest summary (all
   fields + latest customs events); blank sheet; table report (used by Task 12).
4. API `pdf.generate({ movementId, kind })`, `pdf.blankDriverSheets({ from, to, … })`
   (`movement.read`), `pdf.download({ id })` → 60 s signed URL. `GET /api/pdf/[id]` checks the
   session then redirects to the signed URL (for "Print" in a new tab).
5. UI: `print-menu.tsx` in the review step (Print / Download PDF / Email — email wired in
   Task 8); movements list toolbar "Blank driver sheets" dialog.
6. `render.test.ts`: each template renders to a buffer starting with `%PDF` and > 1 kB.

**Acceptance:** unit; integration (`generated_documents` RLS); typecheck/lint; Playwright
`movements.spec.ts` "Download PDF" returns a URL containing `.pdf`.

---

## Task 8: Twilio SMS, driver/dispatch notifications, company profile (gaps 14, 19)

**Migration:** `supabase/migrations/0025_sms_and_company_profile.sql`
**Files:** `packages/integrations/src/{sms.ts (new),sms.test.ts,index.ts}`,
`packages/domain/src/{notification.ts,organization.ts,registry.ts}`,
`packages/api/src/services/{notifications.ts,driver-notify.ts (new),jobs.ts,movements.ts}`,
`packages/api/src/router/{organization,notifications,pdf}.ts`,
`apps/web/src/app/(app)/settings/organization/organization-form.tsx`,
`apps/web/src/app/(app)/settings/notifications/notification-rules-panel.tsx`,
`apps/web/src/components/registry/fields.ts`, `packages/db/src/schema/{core,registry,notifications}.ts`,
`.env.example`, `turbo.json`, seed.

1. `sms.ts`: `sendSms({ to, body }, env)` via Twilio REST (`fetch` to
   `https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json`, Basic auth); env
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`; `smsMode()` → `mock` when
   any is missing (never throws) — same shape as `email.ts`.
2. SQL: `organizations` add `timezone text not null default 'America/Toronto'`,
   `billing_address jsonb`, `include_pars_in_cargo_numbers boolean not null default false`,
   `dispatch_emails text[] not null default '{}' check (cardinality(dispatch_emails) <= 5)`;
   `drivers` add `sms_opt_in boolean default false`, `sms_phone_ace text`, `sms_phone_aci text`,
   `email_driver_sheet boolean default true`; `user_profiles.phone text`;
   `notification_rules.channel` and `notifications.channel` checks gain `'sms'`.
   `shipments_control_number()` trigger: for ACI, prefix `PARS` when
   `include_pars_in_cargo_numbers` and `is_pars`.
3. Domain: `notificationChannel = ["in_app","email","sms"]`; new event types
   `movement.accepted` and `shipment.entry_on_file` (permission `movement.read`);
   `organizationUpdateInput` and `driverInput` gain the fields. Fan-out in `notifications.ts`
   sends SMS when the rule includes `sms` and `user_profiles.phone` is set (logged as an
   `integration_event` like email).
4. `driver-notify.ts`: `JobType` `"driver.notify"` `{ movementId, trigger: 'accepted' |
   'entries_complete' }`, enqueued by `applyCustomsDecision` on `accepted` and when every
   attached shipment has `entry_number`. Handler: generate driver sheet (Task 7); email it
   (Resend, link to signed URL) to `dispatch_emails` and to the PIC's email when
   `email_driver_sheet`; SMS entry numbers (`"PFTR-00012: entry 30039304566 @ 3401"`) to the
   regime-specific phone when `sms_opt_in`; write a `movement_events` `note` by `system` with
   the delivery result.
5. API: `organization.update` extended; `pdf.email({ id, to: email[] })` for the manual
   "Send by email" button; `notifications.rules.upsert` accepts `sms`. UI: organization form
   gains timezone, billing address, dispatch list (5 inputs), PARS toggle, simple-sheet toggle,
   read-only plan block from `billing.summary`; driver SMS fields; SMS checkbox in rules panel.
6. Seed: Singh opted in with a phone; two demo dispatch emails. Tests: `sms.test.ts` (mock
   result), `driver-notify.test.ts` with mocked senders.

**Acceptance:** unit; integration (rules with `sms`); typecheck/lint; after seeding, driving a
seeded movement to `accepted` via the dev `customsResponse` procedure and calling
`GET /api/jobs/process` shows a succeeded `driver.notify` job in `background_jobs`.

---

## Task 9: In-bond monitor and external shipments (gaps 11, 12)

**Migration:** `supabase/migrations/0026_in_bond.sql`
**Files:** `packages/db/src/schema/inbond.ts` (new), `packages/domain/src/{inbond.ts (new),permission.ts}`,
`packages/integrations/src/customs/{types,mock,gateway/*}.ts`,
`packages/api/src/services/inbond.ts` (new), `packages/api/src/router/inbond.ts` (new), `_app.ts`,
`apps/web/src/app/(app)/in-bond/{page.tsx,in-bond-monitor.tsx,external-shipments.tsx}` (new),
`app-shell.tsx`, seed, `packages/db/src/inbond.integration.test.ts` (new), `apps/web/e2e/in-bond.spec.ts` (new).

1. SQL `public.external_shipments`: `id`, `organization_id`, `regime`, `control_number text`
   (other carrier's SCN/BOL), `in_bond_number text`, `originating_carrier_code text`,
   `description`, `status text check in ('open','closed')`, timestamps; check at least one of
   `control_number`/`in_bond_number`. `public.in_bond_records`: `id`, `organization_id`,
   `shipment_id null`, `external_shipment_id null` (check exactly one set), `bond_number text
   check (bond_number ~ '^\d{9}$')`, `entry_type text check in ('IT','TE','IE')`,
   `arrival_port_id`, `export_port_id`, `firms_code text`, `status text check in ('open',
   'arrival_sent','arrived','export_sent','exported','cancelled')`, `last_status_checked_at`,
   timestamps. `public.in_bond_events` (`in_bond_record_id` cascade, `organization_id`, `kind
   text check in ('arrival_sent','export_sent','cancel_sent','status_requested',
   'customs_response','note')`, `actor_type`, `payload jsonb`, `occurred_at`). Permissions
   `inbond.read`, `inbond.write`.
2. `CustomsClient` gains `inBondArrival(rec)`, `inBondExport(rec)`, `inBondCancel(rec)`,
   `inBondStatus(bondNumber)` (mock + gateway `POST /in-bond/{bond}/arrival|export|cancel`,
   `GET /in-bond/{bond}`). Arrival/export/cancel require arrival port, export port and FIRMS
   code (Avaal rule) — enforced in zod.
3. Domain `inbond.ts`: `inBondRecordInput`, `externalShipmentInput`, `IN_BOND_TRANSITIONS`.
   Router `inbond.records.list/create/update/sendArrival/sendExport/cancel/requestStatus`,
   `inbond.external.list/create/update/close`; every send logs a `customs_submissions` row
   (kind `in_bond`) and an `in_bond_events` row; creating an `in_bond` shipment (Task 2)
   auto-creates an `in_bond_records` row; status responses also `notifyOrganization`
   (`customs.decision`).
4. UI `/in-bond` with two tabs (Monitor table + action buttons + event drawer; External
   shipments CRUD). Nav "In-bond" (`inbond.read`).
5. Seed: one in-bond shipment with record, one external shipment.

**Acceptance:** reset+seed; `verify:mirror`; integration (RLS ×3, one-of check); unit;
typecheck/lint; Playwright `in-bond.spec.ts` (send arrival → event row appears).

---

## Task 10: PARS RNS feed and gated public PAPS/PARS lookup (gaps 2 RNS, 17)

**Migration:** `supabase/migrations/0027_pars_rns_and_tracking.sql`
**Files:** `packages/db/src/schema/movements.ts`, `packages/domain/src/{tracking.ts (new),shipment.ts}`,
`packages/api/src/router/{tracking.ts (new),shipment.ts,_app.ts}`,
`packages/api/src/services/{movements.ts,tracking.ts (new)}`,
`packages/api/src/infra/ratelimit.ts`,
`apps/web/src/app/track/page.tsx` (new, outside `(app)`), `apps/web/src/app/(auth)/login/page.tsx`,
`apps/web/src/proxy.ts`, `apps/web/src/app/(app)/pars-rns/page.tsx` (new), `app-shell.tsx`,
`apps/web/e2e/tracking.spec.ts` (new).

1. SQL `public.pars_rns_events`: `id`, `organization_id`, `shipment_id null`, `pars_number`,
   `release_code text`, `released_at timestamptz`, `office_code`, `sublocation_code`,
   `transaction_number`, `container_number`, `raw jsonb`, `received_at`; indexes
   `(organization_id, received_at desc)`, `(pars_number)`. Populated by
   `applyCustomsDecision` when an ACI `released` event carries RNS fields (mock emits them).
   SQL function `public.lookup_shipment_status(p_carrier_code text, p_control_number text)
   returns table (status text, port_code text, port_name text, entry_number text, updated_at
   timestamptz, released_at timestamptz)` — SECURITY DEFINER, `set search_path = public`,
   execute granted to `service_role` only; joins `shipments → movements → ports`; at most one
   row; never returns org, driver, truck or commodity data.
2. Domain `tracking.ts`: `trackingLookupInput { carrierCode: /^[A-Z0-9]{2,4}$/, controlNumber:
   /^[A-Z0-9]{6,24}$/ }`, `trackingResult`.
3. API `tracking.lookup` (`publicProcedure`): rate limit `track:<ip>` 10/min and 100/day via
   `rateLimitFor("public")` (new tier in `packages/api/src/infra/ratelimit.ts`, `MemoryKv` when Redis is absent); `TOO_MANY_REQUESTS` on limit; calls the
   function under `withServiceRole`; uniform `{ found: false }` on miss; logs only a hashed IP
   counter.
4. `shipment.rns.list({ q?, range })` for `/pars-rns` (columns: PARS#, release code, time,
   office, sub-location, transaction #, container #).
5. Web: `/track` (no app shell; form + result card); `PUBLIC_PATHS` += `"/track"`; login page
   link "Check PAPS/PARS status". Nav "PARS RNS" (`shipment.read`).
6. Tests: unit (input validation, limiter); integration (`authenticated` cannot execute the
   function); Playwright `tracking.spec.ts` (seeded control number → status shown; wrong code
   → not found; 11th call → 429).

**Acceptance:** reset+seed; integration; unit; Playwright `tracking.spec.ts`; typecheck/lint.

---

## Task 11: CSV bulk import and batch delete for shipments and commodities (gap 13)

**Migration:** `supabase/migrations/0028_import_batches.sql`
**Files:** `packages/db/src/schema/movements.ts`, `packages/domain/src/{imports.ts (new),permission.ts}`,
`packages/api/package.json` (add `papaparse`, `@types/papaparse`),
`packages/api/src/services/imports.ts` (new), `packages/api/src/router/imports.ts` (new), `_app.ts`,
`apps/web/src/app/(app)/shipments/import/{page.tsx,import-wizard.tsx}` (new),
`docs/import-templates/{ace-shipments,aci-cargo,commodities}.csv` (new), seed, tests.

1. SQL `public.import_batches`: `id`, `organization_id`, `kind text check in ('shipments',
   'commodities')`, `filename`, `row_count int`, `ok_count int`, `error_count int`,
   `status text check in ('validated','committed','deleted')`, `report jsonb`, `created_by`,
   `created_at`. FKs `shipments.import_batch_id` and `commodities.import_batch_id` →
   `import_batches(id) on delete set null`. Permission `import.run`.
2. Parser `papaparse` server-side (header row, `skipEmptyLines`, delimiter auto-detect covers
   `.csv/.txt/.dat`). Domain `imports.ts`: `IMPORT_TEMPLATES` column specs — shipments:
   `regime, carrier_code, control_reference, shipment_type|cargo_type, shipper_name,
   consignee_name, entry_port, in_bond_entry_type, in_bond_destination, is_pars,
   destination_port, sublocation, loading_country, loading_province, loading_city,
   consignee_business_number`; commodities: `control_number, line_number, description, hs_code,
   quantity, quantity_unit, weight, weight_unit, country_of_origin, marks_and_numbers,
   hazmat_code_1..3, hazmat_description_1..3, hazmat_contact_1..3, hazmat_phone_1..3,
   value_amount, value_currency, is_consolidated`; `importRowSchema` per kind; `importReport
   { rows: [{ line, status: 'ok'|'error', errors: [{ column, message }] }], okCount, errorCount }`.
3. API: `imports.validate({ kind, filename, content: z.string().max(2_000_000) })` → parse,
   resolve partners by name / ports by code / carrier code, reject duplicate control numbers
   (in file and in DB), persist batch `validated` + report; `imports.commit({ batchId })`
   inserts only `ok` rows in one transaction, stamps `import_batch_id`, sets `committed`;
   `imports.list`; `imports.deleteBatch({ batchId })` deletes draft rows of the batch and
   reports non-draft ones; `imports.template({ kind })` returns the header line.
4. UI wizard: file read client-side → validate table (line/column/message) → commit; "Batches"
   list with delete. Link from `/shipments` toolbar.
5. Tests: `imports.test.ts` (bad enum, missing partner, duplicate control number, hazmat
   triplet); integration (batch RLS).

**Acceptance:** unit; integration; typecheck/lint; Playwright `shipments.spec.ts` import
round-trip with `docs/import-templates/ace-shipments.csv`.

---

## Task 12: Crossing reports with column picker and exports; dashboard monthly counts; partner direction rules (gaps 15, 18, 20)

**Migration:** none
**Files:** `packages/domain/src/{reporting.ts,registry.ts}`,
`packages/api/src/router/{reporting,party,organization}.ts`,
`packages/api/src/services/{reporting-export.ts (new),pdf.ts}`, `packages/pdf/src/templates/table-report.tsx`,
`apps/web/src/app/(app)/reports/{report-workbench.tsx,crossing-report.tsx (new),page.tsx}`,
`apps/web/src/components/reports/column-picker.tsx` (new),
`apps/web/src/app/(app)/dashboard/{page.tsx,monthly-chart.tsx (new)}`,
`apps/web/src/components/registry/registry-page.tsx`, `apps/web/src/components/shipment/shipment-form.tsx`.

1. Domain: `CROSSING_REPORT_COLUMNS` (26 keys: movementNumber, tripNumber, regime, carrierCode,
   status, portCode, portName, scheduledCrossingAt, submittedAt, acceptedAt, releasedAt,
   arrivedAt, picDriver, crew, truckUnit, truckPlate, trailerUnits, sealNumbers, shipmentCount,
   controlNumbers, entryNumbers, shippers, consignees, commodityCount, totalWeightKg,
   declaredValue); `crossingReportInput { from, to, regime?, driverId?, portId?, truckId?,
   trailerId?, columns: z.array(crossingColumn).min(1).default(DEFAULT_COLUMNS), limit, offset }`;
   `exportFormat = z.enum(["csv","pdf"])`.
2. API: `reporting.crossings(input)` (SQL over movements + joins, `string_agg` for lists);
   `reporting.export({ query: crossingReportInput | reportQuery, format })` → CSV (RFC 4180,
   UTF-8 BOM) or PDF via `table-report.tsx`, stored as `generated_documents.kind='report'`,
   returns signed URL; `reporting.dashboard()` → `{ thisMonth: { ACE, ACI }, series: 12 months
   of { month, ACE, ACI }, recentShipments: 10 × { controlNumber, status, entryNumber,
   movementNumber, updatedAt } }`; `party.<registry>.export({ format })` (`registry_export`).
   `partnerInput.address.country` required; `party.partners.list` gains `direction`
   (`shipper|consignee`) and the shipment form pre-filters CA shippers / US consignees for ACE
   (reverse for ACI) with an override toggle.
3. UI: `crossing-report.tsx` (date range + filters + `ColumnPicker` with select-all, persisted in
   `localStorage` `corridor.report.columns` + table + Export CSV/PDF); NL workbench gets Export
   buttons. Dashboard: ACE/ACI created-this-month tiles, `monthly-chart.tsx` (inline SVG,
   stacked bars), recent shipments table. Registry page toolbar "Export CSV / PDF".
4. Tests: unit (CSV escaping, column selection); Playwright `reporting.spec.ts` (export link),
   `foundations.spec.ts` (dashboard tiles).

**Acceptance:** unit; typecheck/lint; Playwright `reporting.spec.ts`, `foundations.spec.ts`.

---

## Task 13: Resources page, in-app manual and support, per-record history, auth conveniences (gaps 21–24)

**Migration:** none
**Files:** `apps/web/src/app/(app)/resources/{page.tsx,resources-panel.tsx}` (new),
`apps/web/src/app/(app)/help/{page.tsx,[slug]/page.tsx}` (new), `docs/user-manual/*.md` (new),
`packages/api/src/router/{reference,audit}.ts`, `apps/web/src/components/record-history.tsx` (new),
`apps/web/src/app/(auth)/{forgot-password,reset-password}/page.tsx` (new),
`apps/web/src/app/(app)/settings/profile/{page.tsx,profile-panel.tsx}` (new),
`apps/web/src/app/(auth)/login/page.tsx`, `apps/web/src/proxy.ts`, `packages/auth/src/*` (cookie options),
`app-shell.tsx`, `apps/web/package.json` (add `marked`), `.env.example`, `turbo.json`.

1. Resources page: cards for CBP border wait times, CBSA wait times, USPS ZIP lookup, Canada
   Post lookup, HTS search, CBSA broker list, US broker list by port (external links, `rel=
   "noopener"`), plus embedded widgets `reference.borderWait({ portId })` (`getBorderWait`,
   5-min cache) and `reference.tariffSearch({ q })` (`searchTariff`). Nav "Resources".
2. Help: `docs/user-manual/*.md` (≥8 pages: movements, shipments, crew, equipment, customs
   filing, in-bond, imports, reports) rendered by a server component with `marked`; sidebar
   index; support card from `NEXT_PUBLIC_SUPPORT_EMAIL`, `NEXT_PUBLIC_SUPPORT_PHONE`,
   `NEXT_PUBLIC_SUPPORT_URL`. Nav "Help".
3. Per-record history: `audit.forEntity({ entityType, entityId, limit })` as
   `anyPermissionProcedure` keyed by an entity → read-permission map; `RecordHistoryDialog`
   button on registry rows, shipment detail and the movement review step.
4. Auth: `/forgot-password` (`resetPasswordForEmail` → `/reset-password`), `/reset-password`
   (`updateUser({ password })`), both added to `PUBLIC_PATHS`; login "Stay signed in" checkbox
   controls the auth cookie `maxAge` (session vs persistent) in the `@supabase/ssr` cookie
   options in `packages/auth`; `/settings/profile` (display name, phone from Task 8, change
   password). SETTINGS nav "My profile".
5. Tests: unit for the `audit.forEntity` permission map; Playwright `foundations.spec.ts`
   renders forgot-password and help pages.

**Acceptance:** unit; typecheck/lint; Playwright `foundations.spec.ts`.

---

## Task 14: List UX — column chooser, search-by-column, page size, auto-refresh, bulk actions (gap 25)

**Migration:** none
**Files:** `apps/web/src/components/list/{list-toolbar.tsx,column-chooser.tsx,use-auto-refresh.ts,use-list-prefs.ts}` (new),
`apps/web/src/components/registry/registry-page.tsx`,
`apps/web/src/app/(app)/movements/{page.tsx,movements-list.tsx (new)}`, `apps/web/src/app/(app)/shipments/page.tsx`,
`packages/domain/src/{registry.ts,movement-inputs.ts,shipment.ts}`,
`packages/api/src/router/{party,movement,shipment}.ts`, `apps/web/e2e/registries.spec.ts`.

1. Domain list inputs gain `searchColumn?` (enum of that list's columns) and
   `pageSize: z.number().int().min(10).max(200).default(25)`; API list procedures filter
   `ilike` on the named column when present, else global search as today.
2. `party.<registry>.bulkSetStatus({ ids: uuid[] (max 200), status })` (write permission, one
   audit row per record); `shipment.bulkRemove({ ids })` (drafts only).
3. UI: `ListToolbar` (search + column dropdown, page-size select, auto-refresh toggle with
   countdown via `useAutoRefresh(intervalSec, refetch)`), `ColumnChooser` reusing Task 12's
   `ColumnPicker` (persisted under `corridor.list.<name>`), checkbox column with "Activate /
   Deactivate / Delete selected". Adopt in registry page, movements list (extract the table
   into `movements-list.tsx` client component), shipments list. Keep Playwright-asserted labels.
4. Tests: `registries.spec.ts` bulk-deactivates two drivers; unit for `useListPrefs`.

**Acceptance:** unit; typecheck/lint; Playwright `registries.spec.ts`, `movements.spec.ts`,
`shipments.spec.ts`.

---

## Verification (end to end)

After every task: `pnpm typecheck && pnpm lint && pnpm test`; for SQL tasks additionally
`pnpm exec supabase db reset && pnpm db:seed && pnpm --filter @corridor/db verify:mirror &&
pnpm db:lint && pnpm --filter @corridor/db test:integration`. Playwright (`pnpm --filter web e2e`) runs locally
against the seeded DB with the demo users; CI must not be dispatched (billing disabled).

Final parity check after Task 14, in the browser (agentyc MCP) as `dispatch@pathfinder.demo`:
1. Create an ACE movement, add two crew (one PIC), two trailers with seals, assign an existing
   PAPS shipment and add a new in-bond shipment; validation shows no blocking issues.
2. Submit; timeline shows `Sending → Preliminary check passed → Accepted → Entry on file →
   Released` (mock); shipment rows show entry numbers.
3. Download the driver sheet PDF; `driver.notify` job succeeded with mock email + SMS logged
   in `integration_events`.
4. `/track` with the carrier code + control number returns the status; 11th request → 429.
5. Import `docs/import-templates/ace-shipments.csv`, commit, then delete the batch.
6. Crossing report with a custom column set exports CSV and PDF; dashboard shows monthly counts.
7. In-bond monitor: send arrival on the seeded record → event row + notification.
