-- =============================================================================
-- Corridor — 0028 CSV bulk import batches (Avaal parity gap 13)
--
--   public.import_batches — one validated-then-committed CSV upload of
--   shipments or commodity lines, with its row report; the rows it created
--   point back at it so a batch can be deleted in one go.
--   Permission import.run is added by the generated seed.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- import_batches
--
-- Why a new table: the grain is one CSV file a dispatcher ran through the
-- import wizard — its counts, its per-line validation report and whether it
-- was committed or deleted. `source_documents` was considered: it is a file
-- in Storage handed to AI extraction with a review lifecycle; an import is
-- parsed synchronously, never stored as an object, and produces many rows at
-- once. `generated_documents` is output, not input. No existing table has the
-- "one bulk load" grain.
-- -----------------------------------------------------------------------------

create table public.import_batches (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind            text not null check (kind in ('shipments','commodities')),
  filename        text not null,
  row_count       int not null default 0,
  ok_count        int not null default 0,
  error_count     int not null default 0,
  status          text not null default 'validated' check (status in ('validated','committed','deleted')),
  -- { rows: [{ line, status, errors: [{ column, message }] }], payload: [resolved ok rows] }
  report          jsonb not null default '{}'::jsonb,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  committed_at    timestamptz,
  deleted_at      timestamptz
);

create index import_batches_organization_id_idx on public.import_batches (organization_id);
create index import_batches_org_created_idx on public.import_batches (organization_id, created_at desc);

-- The rows a batch created point back at it (shipments.import_batch_id was
-- reserved in 0019 without its key).
alter table public.shipments
  add constraint shipments_import_batch_id_fkey
  foreign key (import_batch_id) references public.import_batches(id) on delete set null;
create index shipments_import_batch_idx on public.shipments (import_batch_id)
  where import_batch_id is not null;

alter table public.commodities
  add column import_batch_id uuid references public.import_batches(id) on delete set null;
create index commodities_import_batch_idx on public.commodities (import_batch_id)
  where import_batch_id is not null;

alter table public.import_batches enable row level security;

create policy import_batches_select on public.import_batches for select to authenticated
  using (public.has_permission(organization_id, 'shipment.read'));
create policy import_batches_modify on public.import_batches for all to authenticated
  using (public.has_permission(organization_id, 'import.run'))
  with check (public.has_permission(organization_id, 'import.run'));

grant select, insert, update, delete on public.import_batches to authenticated, service_role;
