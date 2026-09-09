# Avaal `pftrans` UI Migration Design

Date: 2026-09-09

## Objective

Replace the existing Pathfinder demo tenant data in the local Corridor environment with the
company setup, master records, and complete ACE/ACI filing history visible in the Avaal account
whose username is `pftrans`.

The Avaal source is read-only. All source extraction must use visible UI pages and controls in an
agentyc-controlled Chrome session. The migration must not call Avaal APIs, hidden network
endpoints, direct HTTP routes, database interfaces, or export downloads.

## Scope

### Source data

The migration captures every page and detail view available to the authenticated `pftrans`
account for:

- Company Information
- Users and user profiles
- E-mail Preferences
- Drivers and their visible travel or credential documents
- Trucks, trailers, plates, insurance, and expiry information
- Shippers and consignees
- ACE eManifests and shipments
- ACI trips and cargos
- Commodity, crew, equipment, port, partner, status, and timeline details attached to those
  filings
- External shipments, TCP, PARS RNS, and in-bond records when they are referenced by an imported
  manifest, shipment, trip, or cargo

Notifications, support content, user manuals, and generic web-portal links are not tenant data and
are excluded.

### Target behavior

- Preserve the existing Pathfinder organization UUID so local routes and tenant references remain
  stable.
- Replace all Pathfinder demo memberships, registries, movements, shipments, related child rows,
  and mock integration configuration with the migrated Avaal data.
- Provision `pftransinc@gmail.com` as the Corridor Owner account. The Avaal username `pftrans`
  identifies the source account but is not used as a Corridor login because Corridor authenticates
  by e-mail.
- Import other Avaal users as Corridor users only when the visible Avaal UI supplies a valid e-mail
  address. Report username-only accounts for user review instead of inventing an e-mail address.
- Use the previously supplied password only as an in-memory Supabase Auth input. Never write it to
  the repository, source snapshot, logs, SQL files, or reports.
- Remove the five `@pathfinder.demo` authentication users only after the replacement tenant and new
  administrator have passed verification.

## Extraction Architecture

### Browser source

The extractor uses the existing visible Chrome session through agentyc MCP. It performs only
read-only UI interactions: navigation, pagination, sorting when needed for stable traversal,
opening detail screens or read-only modals, and reading visible DOM content.

For every category, it records:

- List-page record count when Avaal displays one
- Page number and page size
- Stable Avaal record identifier or the strongest visible natural key
- Detail-page URL
- Field labels and displayed values
- Visible child tables, status history, and relationships
- Extraction timestamp and any warning encountered

The traversal continues until the next-page control is absent or disabled and a full page adds no
new record identifiers. Duplicate identifiers are rejected during extraction rather than silently
overwritten.

### Private source snapshot

The extractor writes an immutable, permission-restricted snapshot beneath an ignored local import
directory. Each entity category has a structured data file plus a manifest containing counts,
page coverage, warnings, and hashes. Screenshots are taken only for ambiguous UI states, not for
every record.

No Corridor rows are changed until every in-scope Avaal category has both:

1. a complete snapshot whose unique count agrees with Avaal's displayed count when the UI supplies
   one; and
2. a complete traversal manifest proving the final pagination page was reached when the UI supplies
   no total count.

An inaccessible category, inaccessible record, expired session, unexplained count mismatch,
repeated record ID, or failed detail page stops the migration before replacement begins. Exceptions
may document visible fields that Corridor cannot represent, but never permit a source record to be
skipped.

## Mapping to Corridor

### Account and organization

- Avaal Company Information maps to `organizations` and `organization_carrier_codes`.
- Avaal users map to Supabase Auth users, `user_profiles`, `organization_members`, and equivalent
  tenant roles.
- The Avaal `Customer Admin` role maps to the Corridor tenant-scoped `Owner` role.
- Avaal e-mail preferences map to organization dispatch addresses and Corridor notification rules
  where the semantics match.

### Master registries

- Drivers map to `drivers`; visible travel and credential documents map to `driver_documents`.
- Trucks and trailers map to their matching Corridor registries; additional plates map to
  `equipment_plates`.
- Avaal shippers and consignees map to `partners`. A company used in both roles becomes one partner
  with the combined role.
- Natural keys such as carrier code, unit number, VIN, licence number, and normalized partner name
  are used to reconnect references while importing.

### Filing history

- ACE eManifests and ACI trips map to Corridor `movements` with the matching regime.
- ACE shipments and ACI cargos map to Corridor `shipments` and attach to the correct movement.
- Commodity lines, crew, equipment, partners, ports, dates, filing identifiers, response status,
  and visible status history map to the corresponding Corridor child and customs-event records.
- Original Avaal identifiers are retained in the closest supported source/reference field so the
  source record can be traced from Corridor.

Values are normalized only when Corridor requires a canonical enum, date, country, jurisdiction,
or port code. The snapshot always keeps the exact displayed Avaal value. Any visible value that
has no safe Corridor representation is listed in the exception report and is never silently
dropped.

## Replacement and Recovery

Before mutation, create a full local PostgreSQL backup and record current Pathfinder row counts by
table. Verify that the backup can be listed and read.

The replacement preserves the organization row and performs tenant-data deletion and insertion in
one database transaction, ordered around foreign-key dependencies. Authentication administration
uses the Supabase Admin API outside that transaction:

1. Ensure the intended administrator Auth user exists.
2. Replace tenant data and membership transactionally.
3. Verify target data and administrator access.
4. Remove obsolete demo Auth users only after verification succeeds.

If transformation, insertion, constraint, or verification fails, roll back the database
transaction and leave demo authentication users intact. If a failure occurs after commit, restore
the database backup and remove only newly created Auth users whose IDs were recorded by the
migration run.

## Validation

### Before replacement

- Avaal displayed counts agree with unique snapshot counts whenever Avaal provides totals.
- Every list record has a captured detail result or an explicit blocking exception.
- Every filing relationship resolves to a captured movement, shipment, partner, driver, or piece
  of equipment as appropriate.
- Required Corridor fields can be populated without invented operational values.

### After replacement

- Compare source snapshot and Corridor counts for every category.
- Run orphan checks across movements, shipments, commodities, crew, equipment, and partners.
- Compare representative ACE and ACI records field by field, including one record from each status
  observed in Avaal.
- Sign into Corridor with the new administrator and confirm the company profile, registries,
  movement lists, shipment lists, and detail pages render correctly.
- Confirm no `@pathfinder.demo` membership or seeded Pathfinder operational row remains.
- Produce a final migration report with extracted, imported, skipped, and failed counts and all
  unmapped fields.

## Security and Operational Constraints

- Avaal is never modified.
- Avaal credentials are entered only in the browser and are never persisted by migration code.
- The private snapshot and database backup are excluded from Git, stored with owner-only
  permissions, and treated as sensitive carrier data.
- Browser output and migration logs redact passwords, session cookies, tokens, and secret keys.
- Source extraction may be resumed after a session timeout only from the last fully completed page;
  partial-page results are discarded and re-read.
- The migration is idempotent at the snapshot-to-Corridor stage: rerunning against the same
  snapshot produces the same target records and counts.

## Success Criteria

The migration is complete when:

1. every in-scope Avaal UI list and detail record has been visited and accounted for;
2. all supported visible values and relationships exist in Corridor;
3. every unmappable value is documented rather than omitted silently;
4. the Pathfinder demo data and demo memberships have been replaced;
5. the Corridor administrator can sign in and browse both ACE and ACI history; and
6. count, integrity, and representative record comparisons pass with a recoverable backup retained.
