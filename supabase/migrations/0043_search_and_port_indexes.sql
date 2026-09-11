-- =============================================================================
-- Corridor — 0043 port FK indexes + trigram indexes for the movement search
--
-- ISSUE-012: the six `ports(id)` foreign keys on shipments / in_bond_records
-- had no index (0019, 0026); `movements.port_id` (0018) was the only one that
-- did. Filtering shipments by entry/destination port and the in-bond port
-- lookups seq-scanned. `ports` is reference data, so the `on delete` walk is
-- not the driver — the lookups are.
--
-- ISSUE-027: 0034 indexed movement_number and the driver name columns, but
-- movement.list's default search ORs movement_number, trip_number and
-- customs_reference_number, and the driver branch matches the concatenation
-- `first_name || ' ' || last_name`, which no single-column index can serve.
-- =============================================================================

create index if not exists shipments_entry_port_idx
  on public.shipments (entry_port_id) where entry_port_id is not null;
create index if not exists shipments_in_bond_destination_port_idx
  on public.shipments (in_bond_destination_port_id) where in_bond_destination_port_id is not null;
create index if not exists shipments_destination_port_idx
  on public.shipments (destination_port_id) where destination_port_id is not null;
create index if not exists shipments_sublocation_port_idx
  on public.shipments (sublocation_port_id) where sublocation_port_id is not null;
create index if not exists in_bond_records_arrival_port_idx
  on public.in_bond_records (arrival_port_id) where arrival_port_id is not null;
create index if not exists in_bond_records_export_port_idx
  on public.in_bond_records (export_port_id) where export_port_id is not null;

-- movement.list search predicates (packages/api/src/router/movement.ts:152-157)
create index if not exists movements_trip_number_trgm_idx
  on public.movements using gin (trip_number gin_trgm_ops);
create index if not exists movements_customs_reference_trgm_idx
  on public.movements using gin (customs_reference_number gin_trgm_ops);
create index if not exists drivers_full_name_trgm_idx
  on public.drivers using gin ((first_name || ' ' || last_name) gin_trgm_ops);
create index if not exists trucks_unit_number_trgm_idx
  on public.trucks using gin (unit_number gin_trgm_ops);
