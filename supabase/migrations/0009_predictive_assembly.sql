-- =============================================================================
-- Corridor — 0009 predictive assembly + assigned-driver access
-- =============================================================================

-- Explicit auth-user linkage replaces the display-name join previously used
-- to decide which movement belongs to a Driver-Portal user.
alter table public.drivers
  add column user_id uuid references auth.users(id) on delete set null;
create unique index drivers_org_user_unique on public.drivers (organization_id, user_id)
  where user_id is not null;

create or replace function public.is_assigned_movement(p_movement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.movements m
    join public.drivers d on d.id = m.driver_id and d.organization_id = m.organization_id
    where m.id = p_movement_id
      and d.user_id = auth.uid()
      and public.has_permission(m.organization_id, 'movement.read_assigned')
  );
$$;

revoke all on function public.is_assigned_movement(uuid) from public;
grant execute on function public.is_assigned_movement(uuid) to authenticated, service_role;

drop policy movements_select on public.movements;
create policy movements_select on public.movements for select to authenticated
  using (
    public.has_permission(organization_id, 'movement.read')
    or public.is_assigned_movement(id)
  );

drop policy movement_events_select on public.movement_events;
create policy movement_events_select on public.movement_events for select to authenticated
  using (
    public.has_permission(organization_id, 'movement.read')
    or public.is_assigned_movement(movement_id)
  );

drop policy movement_amendments_select on public.movement_amendments;
create policy movement_amendments_select on public.movement_amendments for select to authenticated
  using (
    public.has_permission(organization_id, 'movement.read')
    or public.is_assigned_movement(movement_id)
  );

drop policy cargo_select on public.cargo;
create policy cargo_select on public.cargo for select to authenticated
  using (
    public.has_permission(organization_id, 'movement.read')
    or public.is_assigned_movement(movement_id)
  );

drop policy seals_select on public.seals;
create policy seals_select on public.seals for select to authenticated
  using (
    public.has_permission(organization_id, 'movement.read')
    or public.is_assigned_movement(movement_id)
  );

drop policy drivers_select on public.drivers;
create policy drivers_select on public.drivers for select to authenticated
  using (
    public.has_permission(organization_id, 'driver.read')
    or (
      user_id = auth.uid()
      and public.has_permission(organization_id, 'movement.read_assigned')
    )
  );

drop policy trucks_select on public.trucks;
create policy trucks_select on public.trucks for select to authenticated
  using (
    public.has_permission(organization_id, 'truck.read')
    or exists (
      select 1 from public.movements m
      where m.truck_id = trucks.id and public.is_assigned_movement(m.id)
    )
  );

drop policy trailers_select on public.trailers;
create policy trailers_select on public.trailers for select to authenticated
  using (
    public.has_permission(organization_id, 'trailer.read')
    or exists (
      select 1 from public.movements m
      where m.trailer_id = trailers.id and public.is_assigned_movement(m.id)
    )
  );

drop policy partners_select on public.partners;
create policy partners_select on public.partners for select to authenticated
  using (
    public.has_permission(organization_id, 'partner.read')
    or exists (
      select 1 from public.cargo c
      where (c.shipper_id = partners.id or c.consignee_id = partners.id)
        and public.is_assigned_movement(c.movement_id)
    )
  );

drop policy source_documents_select on public.source_documents;
create policy source_documents_select on public.source_documents for select to authenticated
  using (
    public.has_permission(organization_id, 'document.read')
    or (
      movement_id is not null
      and public.has_permission(organization_id, 'document.upload')
      and public.is_assigned_movement(movement_id)
    )
  );

-- Knowledge writes now flow through the background worker. Direct writes are
-- limited to users who can actually use the copilot.
drop policy org_knowledge_insert on public.organization_knowledge_embeddings;
create policy org_knowledge_insert on public.organization_knowledge_embeddings for insert to authenticated
  with check (public.has_permission(organization_id, 'copilot.use'));

-- Offered/accepted/dismissed rows are the acceptance-rate source of truth.
create table public.movement_suggestions (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  movement_id         uuid not null references public.movements(id) on delete cascade,
  source_movement_id  uuid not null references public.movements(id) on delete cascade,
  score               numeric(5,2) not null check (score between 0 and 100),
  reasons             text[] not null default '{}',
  suggested_payload   jsonb not null,
  status              text not null default 'offered'
                        check (status in ('offered','accepted','dismissed')),
  created_by          uuid references auth.users(id) on delete set null,
  decided_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (movement_id <> source_movement_id)
);

create index movement_suggestions_org_created_idx
  on public.movement_suggestions (organization_id, created_at desc);
create index movement_suggestions_movement_idx
  on public.movement_suggestions (movement_id, created_at desc);

create trigger movement_suggestions_set_updated_at
  before update on public.movement_suggestions
  for each row execute function public.set_updated_at();

create or replace function public.movement_suggestions_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_org uuid;
  v_source_org uuid;
begin
  select organization_id into v_target_org from public.movements where id = new.movement_id;
  select organization_id into v_source_org from public.movements where id = new.source_movement_id;
  if v_target_org is null or v_source_org is null
     or new.organization_id is distinct from v_target_org
     or new.organization_id is distinct from v_source_org then
    raise exception 'suggestion movements must belong to its organization' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'offered' or new.decided_at is not null then
      raise exception 'new suggestions must be offered and undecided' using errcode = 'P0001';
    end if;
    if auth.uid() is not null and new.created_by is distinct from auth.uid() then
      raise exception 'suggestions must be self-attributed' using errcode = '42501';
    end if;
  else
    if new.organization_id is distinct from old.organization_id
       or new.movement_id is distinct from old.movement_id
       or new.source_movement_id is distinct from old.source_movement_id
       or new.score is distinct from old.score
       or new.reasons is distinct from old.reasons
       or new.suggested_payload is distinct from old.suggested_payload
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'offered suggestion fields are immutable' using errcode = 'P0001';
    end if;
    if old.status <> 'offered' or new.status not in ('accepted','dismissed') then
      raise exception 'suggestion decision cannot be changed' using errcode = 'P0001';
    end if;
    new.decided_at := coalesce(new.decided_at, now());
  end if;
  return new;
end;
$$;

create trigger movement_suggestions_guard
  before insert or update on public.movement_suggestions
  for each row execute function public.movement_suggestions_guard();

revoke execute on function public.movement_suggestions_guard() from public;

alter table public.movement_suggestions enable row level security;
create policy movement_suggestions_select on public.movement_suggestions for select to authenticated
  using (public.has_permission(organization_id, 'movement.read'));
create policy movement_suggestions_insert on public.movement_suggestions for insert to authenticated
  with check (public.has_permission(organization_id, 'movement.write'));
create policy movement_suggestions_update on public.movement_suggestions for update to authenticated
  using (public.has_permission(organization_id, 'movement.write'))
  with check (public.has_permission(organization_id, 'movement.write'));

grant select, insert, update on public.movement_suggestions to authenticated;
grant select, insert, update, delete on public.movement_suggestions to service_role;
