-- =============================================================================
-- Corridor — 0007 RAG copilot
-- regulation_documents/regulation_embeddings are GLOBAL reference data (every
-- authenticated user may read them — customs regulations aren't a tenant
-- secret). organization_knowledge_embeddings is tenant-scoped (movement notes,
-- hold resolutions, SOPs). match_regulations/match_org_knowledge are the
-- vector-search RPCs the copilot's retriever calls.
-- =============================================================================

create table public.regulation_documents (
  id              uuid primary key default gen_random_uuid(),
  source          text not null,                          -- e.g. 'CBP 19 CFR', 'CBSA Memoranda D'
  title           text not null,
  jurisdiction    text not null check (jurisdiction in ('US','CA')),
  effective_date  date,
  url             text,
  content         text not null,
  created_at      timestamptz not null default now()
);

create table public.regulation_embeddings (
  id                     uuid primary key default gen_random_uuid(),
  regulation_document_id uuid not null references public.regulation_documents(id) on delete cascade,
  chunk_index            int not null,
  content                text not null,
  embedding              vector(1536) not null,
  metadata               jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  unique (regulation_document_id, chunk_index)
);

create index regulation_embeddings_hnsw_idx on public.regulation_embeddings
  using hnsw (embedding vector_cosine_ops);

create table public.organization_knowledge_embeddings (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_type     text not null check (source_type in ('movement_note','hold_resolution','sop_document')),
  source_id       uuid,
  content         text not null,
  embedding       vector(1536) not null,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index org_knowledge_embeddings_hnsw_idx on public.organization_knowledge_embeddings
  using hnsw (embedding vector_cosine_ops);
create index org_knowledge_embeddings_org_idx on public.organization_knowledge_embeddings (organization_id);

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

alter table public.regulation_documents enable row level security;
alter table public.regulation_embeddings enable row level security;
alter table public.organization_knowledge_embeddings enable row level security;

-- Global reference data: readable by any authenticated user, written only by service role (ingestion).
create policy regulation_documents_select on public.regulation_documents for select to authenticated using (true);
create policy regulation_embeddings_select on public.regulation_embeddings for select to authenticated using (true);

create policy org_knowledge_select on public.organization_knowledge_embeddings for select to authenticated
  using (public.has_permission(organization_id, 'copilot.use'));
create policy org_knowledge_insert on public.organization_knowledge_embeddings for insert to authenticated
  with check (public.is_org_member(organization_id));

grant select on public.regulation_documents, public.regulation_embeddings to authenticated;
grant select, insert on public.organization_knowledge_embeddings to authenticated;
grant select, insert, update, delete on
  public.regulation_documents, public.regulation_embeddings, public.organization_knowledge_embeddings
  to service_role;

-- -----------------------------------------------------------------------------
-- match_regulations: cosine-similarity search over the global corpus.
-- -----------------------------------------------------------------------------

create or replace function public.match_regulations(
  p_query_embedding vector(1536),
  p_match_count int default 5,
  p_jurisdiction text default null
)
returns table (
  regulation_document_id uuid,
  title text,
  source text,
  jurisdiction text,
  url text,
  chunk_index int,
  content text,
  similarity float
)
language sql
stable
security definer
set search_path = public
as $$
  select
    d.id, d.title, d.source, d.jurisdiction, d.url,
    e.chunk_index, e.content,
    1 - (e.embedding <=> p_query_embedding) as similarity
  from public.regulation_embeddings e
  join public.regulation_documents d on d.id = e.regulation_document_id
  where p_jurisdiction is null or d.jurisdiction = p_jurisdiction
  order by e.embedding <=> p_query_embedding
  limit p_match_count;
$$;

grant execute on function public.match_regulations(vector, int, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- match_org_knowledge: cosine-similarity search scoped to one organization.
-- SECURITY DEFINER so it can be called through the RLS transaction, but it
-- explicitly checks membership itself (the vector index can't carry a policy
-- predicate the way plain rows can).
-- -----------------------------------------------------------------------------

create or replace function public.match_org_knowledge(
  p_organization_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 5
)
returns table (
  id uuid,
  source_type text,
  source_id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_permission(p_organization_id, 'copilot.use') then
    raise exception 'not authorized for organization %', p_organization_id using errcode = '42501';
  end if;
  return query
    select k.id, k.source_type, k.source_id, k.content, k.metadata,
           1 - (k.embedding <=> p_query_embedding) as similarity
    from public.organization_knowledge_embeddings k
    where k.organization_id = p_organization_id
    order by k.embedding <=> p_query_embedding
    limit p_match_count;
end;
$$;

grant execute on function public.match_org_knowledge(uuid, vector, int) to authenticated, service_role;
