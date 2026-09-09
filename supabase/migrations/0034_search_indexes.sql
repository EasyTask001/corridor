create extension if not exists pg_trgm;

-- Search endpoints use case-insensitive substring matching.  Trigram indexes
-- keep those predicates indexable without changing their user-facing behavior.
create index if not exists partners_name_trgm_idx
  on public.partners using gin (name gin_trgm_ops);
create index if not exists drivers_first_name_trgm_idx
  on public.drivers using gin (first_name gin_trgm_ops);
create index if not exists drivers_last_name_trgm_idx
  on public.drivers using gin (last_name gin_trgm_ops);
create index if not exists movements_number_trgm_idx
  on public.movements using gin (movement_number gin_trgm_ops);
create index if not exists shipments_control_number_trgm_idx
  on public.shipments using gin (control_number gin_trgm_ops);
create index if not exists source_documents_filename_trgm_idx
  on public.source_documents using gin (original_filename gin_trgm_ops);
