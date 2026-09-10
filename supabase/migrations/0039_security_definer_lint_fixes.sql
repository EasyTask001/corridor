-- Keep SECURITY DEFINER routines compatible with the empty search path set by
-- 0032_database_api_hardening.sql by qualifying extension-owned objects.

create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_user_email public.citext;
  v_member public.organization_members%rowtype;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select email into v_user_email from auth.users where id = v_user_id;

  select * into v_member
  from public.organization_members
  where invite_token = p_token and status = 'invited'
  for update;

  if v_member.id is null then
    raise exception 'invitation not found or already used' using errcode = 'P0002';
  end if;
  if v_member.invite_expires_at is not null and v_member.invite_expires_at < now() then
    raise exception 'invitation expired' using errcode = 'P0002';
  end if;
  if v_member.invited_email is distinct from v_user_email then
    raise exception 'invitation was issued to a different email address' using errcode = '42501';
  end if;

  update public.organization_members
  set user_id = v_user_id, status = 'active', invite_token = null, invite_expires_at = null
  where id = v_member.id;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id)
  values (v_member.organization_id, v_user_id, 'member.accept_invite', 'organization_member', v_member.id::text);

  return v_member.organization_id;
end;
$$;

create or replace function public.match_regulations(
  p_query_embedding public.vector(1536),
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
set search_path = ''
as $$
  select
    d.id, d.title, d.source, d.jurisdiction, d.url,
    e.chunk_index, e.content,
    1 - (e.embedding OPERATOR(public.<=>) p_query_embedding) as similarity
  from public.regulation_embeddings e
  join public.regulation_documents d on d.id = e.regulation_document_id
  where p_jurisdiction is null or d.jurisdiction = p_jurisdiction
  order by e.embedding OPERATOR(public.<=>) p_query_embedding
  limit p_match_count;
$$;

create or replace function public.match_org_knowledge(
  p_organization_id uuid,
  p_query_embedding public.vector(1536),
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
set search_path = ''
as $$
begin
  if not public.has_permission(p_organization_id, 'copilot.use') then
    raise exception 'not authorized for organization %', p_organization_id using errcode = '42501';
  end if;
  return query
    select k.id, k.source_type, k.source_id, k.content, k.metadata,
           1 - (k.embedding OPERATOR(public.<=>) p_query_embedding) as similarity
    from public.organization_knowledge_embeddings k
    where k.organization_id = p_organization_id
    order by k.embedding OPERATOR(public.<=>) p_query_embedding
    limit p_match_count;
end;
$$;
