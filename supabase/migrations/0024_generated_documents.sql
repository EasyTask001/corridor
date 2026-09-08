-- =============================================================================
-- Corridor — 0024 generated documents (Avaal parity gap 9)
--
--   1. public.generated_documents — every PDF Corridor renders (driver sheet,
--      blank driver sheets, manifest summary, reports, registry exports),
--      stored in the private `documents` bucket under <org>/generated/…
--   2. organizations.simple_driver_sheet — Avaal's "simple" sheet without
--      commodity lines.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. generated_documents
--
-- Why a new table: the grain is one file Corridor produced. `source_documents`
-- was considered — it has the same "file in the documents bucket" shape — but
-- its grain is a file a user *uploaded* for AI extraction: it carries the
-- extraction lifecycle (upload_status, extracted_json, confidence, review) and
-- its RLS follows `document.read` / `document.upload`, while a generated
-- sheet has no extraction, is readable by whoever can read the movement
-- (`movement.read`, or `report.read` for a report), and is never edited.
-- Lifecycle and RLS both differ, so it gets its own table.
-- -----------------------------------------------------------------------------

create table public.generated_documents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Null for a blank-sheet batch, a report or a registry export.
  movement_id     uuid references public.movements(id) on delete cascade,
  kind            text not null check (kind in
                    ('driver_sheet','blank_driver_sheet','manifest_summary','report','registry_export')),
  storage_path    text not null unique,
  content_type    text not null default 'application/pdf',
  byte_size       bigint,
  -- Free-form: what the file was rendered from (trip range, report query, …).
  metadata        jsonb not null default '{}'::jsonb,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index generated_documents_organization_id_idx on public.generated_documents (organization_id);
create index generated_documents_org_created_idx on public.generated_documents (organization_id, created_at desc);
create index generated_documents_movement_idx on public.generated_documents (movement_id, created_at desc)
  where movement_id is not null;

alter table public.generated_documents enable row level security;

-- Reports and exports follow report.read; everything about a movement follows
-- movement.read (and a crew member sees their own crossing's sheets).
create policy generated_documents_select on public.generated_documents for select to authenticated
  using (
    case when kind in ('report','registry_export')
      then public.has_permission(organization_id, 'report.read')
      else public.has_permission(organization_id, 'movement.read')
        or (movement_id is not null and public.is_assigned_movement(movement_id))
    end
  );
create policy generated_documents_insert on public.generated_documents for insert to authenticated
  with check (
    case when kind in ('report','registry_export')
      then public.has_permission(organization_id, 'report.read')
      else public.has_permission(organization_id, 'movement.read')
    end
  );

grant select, insert on public.generated_documents to authenticated;
grant select, insert, update, delete on public.generated_documents to service_role;

-- -----------------------------------------------------------------------------
-- 2. organizations.simple_driver_sheet (same grain — column)
-- -----------------------------------------------------------------------------

alter table public.organizations
  add column simple_driver_sheet boolean not null default false;
