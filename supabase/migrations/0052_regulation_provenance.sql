-- =============================================================================
-- Corridor — 0052 regulation provenance and verified-only retrieval
--
--   The seeded regulatory corpus (packages/ai/src/copilot/regulations-corpus.ts)
--   had no way to say *when* a summary was written against its source, or
--   whether anyone had checked it was still current — a citation could be
--   stale or simply wrong (a prior seed cited 19 CFR 149, an ocean ISF rule,
--   for a truck manifest requirement) with nothing in the schema to catch it.
--   These columns let ingestion record that provenance, and match_regulations
--   is rebuilt to only ever retrieve a row someone has actually verified.
-- =============================================================================

alter table public.regulation_documents
  add column authority          text,   -- 'CBP' | 'CBSA' | 'USTR' | ...
  add column version             text,   -- edition/notice identifier, e.g. 'CN 24-27', 'eCFR 2026-09-13'
  add column retrieved_at        timestamptz,
  add column last_verified_at    timestamptz,
  add column verification_status text not null default 'draft'
    check (verification_status in ('draft', 'verified', 'superseded')),
  add column superseded_by       uuid references public.regulation_documents(id) on delete set null,
  add constraint regulation_documents_source_title_unique unique (source, title);

comment on column public.regulation_documents.verification_status is
  'draft: seeded but never checked against the live source. verified: last_verified_at reflects a real read. superseded: superseded_by names the replacement.';

-- Which embedding model produced a chunk's vector. Vectors from different
-- models are not comparable — a mock-embedded corpus queried with a real
-- model's embedding (or vice versa) silently returns garbage similarity
-- scores rather than an error, so match_regulations below can filter on it.
alter table public.regulation_embeddings
  add column embedder text;

-- -----------------------------------------------------------------------------
-- match_regulations: only ever return a verified, non-superseded row, and
-- optionally only rows embedded by the caller's own active embedder.
-- -----------------------------------------------------------------------------

drop function if exists public.match_regulations(vector, int, text);

create function public.match_regulations(
  p_query_embedding public.vector(1536),
  p_match_count int default 5,
  p_jurisdiction text default null,
  p_embedder text default null
)
returns table (
  regulation_document_id uuid,
  title text,
  source text,
  jurisdiction text,
  url text,
  chunk_index int,
  content text,
  similarity float,
  authority text,
  last_verified_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    d.id, d.title, d.source, d.jurisdiction, d.url,
    e.chunk_index, e.content,
    1 - (e.embedding OPERATOR(public.<=>) p_query_embedding) as similarity,
    d.authority, d.last_verified_at
  from public.regulation_embeddings e
  join public.regulation_documents d on d.id = e.regulation_document_id
  where d.verification_status = 'verified'
    and d.superseded_by is null
    and (p_jurisdiction is null or d.jurisdiction = p_jurisdiction)
    and (p_embedder is null or e.embedder = p_embedder)
  order by e.embedding OPERATOR(public.<=>) p_query_embedding
  limit p_match_count;
$$;

grant execute on function public.match_regulations(public.vector, int, text, text) to authenticated, service_role;
