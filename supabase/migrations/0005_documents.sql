-- =============================================================================
-- Corridor — 0005 source documents (Document Intelligence)
-- source_documents rows track uploads (BOL / invoice / rate confirmation),
-- their extraction lifecycle and the AI output awaiting human review. Files
-- live in the private `documents` Storage bucket under <org_id>/<doc_id>/...
-- =============================================================================

create table public.source_documents (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  movement_id             uuid references public.movements(id) on delete set null,
  document_type           text not null default 'other'
                            check (document_type in ('bol','invoice','rate_confirmation','other')),
  detected_type           text check (detected_type in ('bol','invoice','rate_confirmation','other')),
  storage_path            text not null unique,
  original_filename       text not null,
  mime_type               text not null,
  size_bytes              bigint,
  upload_status           text not null default 'uploaded'
                            check (upload_status in ('uploaded','processing','extracted','failed','applied')),
  extracted_json          jsonb,
  extraction_model        text,
  extraction_confidence   numeric(4,3) check (extraction_confidence between 0 and 1),
  extraction_error        text,
  extraction_started_at   timestamptz,
  extraction_completed_at timestamptz,
  reviewed_by             uuid references auth.users(id) on delete set null,
  reviewed_at             timestamptz,
  applied_movement_id     uuid references public.movements(id) on delete set null,
  uploaded_by             uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index source_documents_org_created_idx on public.source_documents (organization_id, created_at desc);
create index source_documents_org_status_idx on public.source_documents (organization_id, upload_status);
create index source_documents_movement_idx on public.source_documents (movement_id) where movement_id is not null;

create trigger source_documents_set_updated_at
  before update on public.source_documents for each row execute function public.set_updated_at();

-- cargo.source_document_id FK deferred from 0003
alter table public.cargo
  add constraint cargo_source_document_id_fkey
  foreign key (source_document_id) references public.source_documents(id) on delete set null;

-- -----------------------------------------------------------------------------
-- RLS — document.read / document.upload / document.review_extraction
-- -----------------------------------------------------------------------------

alter table public.source_documents enable row level security;

create policy source_documents_select on public.source_documents for select to authenticated
  using (public.has_permission(organization_id, 'document.read'));
create policy source_documents_insert on public.source_documents for insert to authenticated
  with check (public.has_permission(organization_id, 'document.upload'));
create policy source_documents_update on public.source_documents for update to authenticated
  using (public.has_permission(organization_id, 'document.review_extraction')
         or public.has_permission(organization_id, 'document.upload'))
  with check (public.has_permission(organization_id, 'document.review_extraction')
              or public.has_permission(organization_id, 'document.upload'));
create policy source_documents_delete on public.source_documents for delete to authenticated
  using (public.has_permission(organization_id, 'document.upload'));

grant select, insert, update, delete on public.source_documents to authenticated, service_role;

-- Realtime: the review UI flips from "processing" to "review" without polling
alter publication supabase_realtime add table public.source_documents;

-- -----------------------------------------------------------------------------
-- Storage bucket + object policies. Paths are <organization_id>/<document_id>/<file>
-- so the first folder segment is the tenant boundary.
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents', 'documents', false, 26214400,
  array['application/pdf','image/png','image/jpeg','image/webp','image/tiff','text/plain','application/json']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy documents_objects_select on storage.objects for select to authenticated
  using (
    bucket_id = 'documents'
    and public.has_permission(((storage.foldername(name))[1])::uuid, 'document.read')
  );
create policy documents_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and public.has_permission(((storage.foldername(name))[1])::uuid, 'document.upload')
  );
create policy documents_objects_update on storage.objects for update to authenticated
  using (
    bucket_id = 'documents'
    and public.has_permission(((storage.foldername(name))[1])::uuid, 'document.upload')
  );
create policy documents_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'documents'
    and public.has_permission(((storage.foldername(name))[1])::uuid, 'document.upload')
  );
