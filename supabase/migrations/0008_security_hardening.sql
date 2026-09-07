-- =============================================================================
-- Corridor — 0008 authorization hardening
-- Keep action permissions and tenant-owned relationships enforceable when an
-- authenticated client writes through Supabase instead of the tRPC API.
-- =============================================================================

-- A custom role can only be assigned inside the organization that owns it.
-- System roles (organization_id is null) remain reusable by every tenant.
create or replace function public.organization_member_role_scope_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role_org uuid;
  v_is_system boolean;
begin
  select organization_id, is_system
    into v_role_org, v_is_system
  from public.roles
  where id = new.role_id;

  if not found then
    raise exception 'role % does not exist', new.role_id using errcode = '23503';
  end if;
  if not v_is_system and v_role_org is distinct from new.organization_id then
    raise exception 'role % does not belong to organization %', new.role_id, new.organization_id
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger organization_members_role_scope_guard
  before insert or update of role_id, organization_id on public.organization_members
  for each row execute function public.organization_member_role_scope_guard();

revoke execute on function public.organization_member_role_scope_guard() from public;

-- Movement transitions use narrower action permissions than ordinary edits.
-- Service-role/background work bypasses this authenticated-user check.
create or replace function public.movements_guard()
returns trigger
language plpgsql
as $$
declare
  v_manifest_changed boolean;
  v_required_permission text;
begin
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.movement_number is distinct from old.movement_number
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'movement identity fields are immutable' using errcode = 'P0001';
  end if;

  v_manifest_changed :=
       new.regime is distinct from old.regime
    or new.crossing_point is distinct from old.crossing_point
    or new.scheduled_crossing_at is distinct from old.scheduled_crossing_at
    or new.driver_id is distinct from old.driver_id
    or new.truck_id is distinct from old.truck_id
    or new.trailer_id is distinct from old.trailer_id
    or new.trip_number is distinct from old.trip_number
    or new.notes is distinct from old.notes;

  if new.status is distinct from old.status
     and not public.movement_can_transition(old.status, new.status) then
    raise exception 'invalid movement transition % -> %', old.status, new.status
      using errcode = 'P0001';
  end if;

  if current_user = 'authenticated' then
    if v_manifest_changed then
      v_required_permission := case
        when old.status = 'accepted' and new.status = 'sent' then 'movement.amend'
        else 'movement.write'
      end;
      if not public.has_permission(old.organization_id, v_required_permission) then
        raise exception 'permission denied: % required', v_required_permission
          using errcode = '42501';
      end if;
    end if;

    if new.customs_reference_number is distinct from old.customs_reference_number
       and not public.has_permission(old.organization_id, 'movement.transmit_to_customs') then
      raise exception 'permission denied: movement.transmit_to_customs required'
        using errcode = '42501';
    end if;

    if new.status is distinct from old.status then
      v_required_permission := case
        when new.status = 'cancelled' then 'movement.cancel'
        when old.status = 'accepted' and new.status = 'sent' then 'movement.amend'
        when new.status = 'sent' then 'movement.transmit_to_customs'
        when new.status in ('accepted', 'rejected', 'released', 'held')
          then 'movement.transmit_to_customs'
        else 'movement.write'
      end;
      if not public.has_permission(old.organization_id, v_required_permission) then
        raise exception 'permission denied: % required', v_required_permission
          using errcode = '42501';
      end if;
    end if;

    -- Lifecycle timestamps are produced by this trigger, never supplied by a
    -- client. Preserve their old values before stamping the current action.
    new.submitted_at := old.submitted_at;
    new.accepted_at := old.accepted_at;
    new.rejected_at := old.rejected_at;
    new.released_at := old.released_at;
    new.arrived_at := old.arrived_at;
    new.cancelled_at := old.cancelled_at;
  end if;

  if new.status is distinct from old.status then
    case new.status
      when 'sent'      then new.submitted_at := coalesce(new.submitted_at, now());
      when 'accepted'  then new.accepted_at  := now();
      when 'rejected'  then new.rejected_at  := now();
      when 'released'  then new.released_at  := now();
      when 'arrived'   then new.arrived_at   := now();
      when 'cancelled' then new.cancelled_at := now();
      else null;
    end case;
  elsif not public.movement_is_editable(old.status) and v_manifest_changed then
    raise exception 'movement % is not editable in status %', old.movement_number, old.status
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop policy movements_update on public.movements;
create policy movements_update on public.movements for update to authenticated
  using (
       public.has_permission(organization_id, 'movement.write')
    or public.has_permission(organization_id, 'movement.transmit_to_customs')
    or public.has_permission(organization_id, 'movement.amend')
    or public.has_permission(organization_id, 'movement.cancel')
  )
  with check (
       public.has_permission(organization_id, 'movement.write')
    or public.has_permission(organization_id, 'movement.transmit_to_customs')
    or public.has_permission(organization_id, 'movement.amend')
    or public.has_permission(organization_id, 'movement.cancel')
  );

-- Timeline rows must belong to their parent movement. Event categories also
-- require the corresponding action permission and user events are self-attributed.
create or replace function public.movement_events_guard()
returns trigger
language plpgsql
as $$
declare
  v_movement_org uuid;
  v_movement_status text;
begin
  select organization_id, status into v_movement_org, v_movement_status
  from public.movements where id = new.movement_id;
  if not found then
    raise exception 'movement % not found', new.movement_id using errcode = 'P0002';
  end if;
  if new.organization_id is distinct from v_movement_org then
    raise exception 'movement event organization does not match its movement'
      using errcode = '42501';
  end if;
  if new.event_type = 'status_change' and new.to_status is distinct from v_movement_status then
    raise exception 'movement event status does not match its movement' using errcode = 'P0001';
  end if;
  if current_user = 'authenticated' then
    if new.actor_type = 'user' and new.actor_id is distinct from auth.uid() then
      raise exception 'user movement events must be self-attributed' using errcode = '42501';
    end if;
    if new.actor_type <> 'user' and new.actor_id is not null then
      raise exception 'non-user movement events cannot have a user actor' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger movement_events_guard
  before insert on public.movement_events
  for each row execute function public.movement_events_guard();

drop policy movement_events_insert on public.movement_events;
create policy movement_events_insert on public.movement_events for insert to authenticated
  with check (
    case event_type
      when 'note' then public.has_permission(organization_id, 'movement.write')
      when 'amendment' then public.has_permission(organization_id, 'movement.amend')
      when 'customs_response' then
        public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'ai_flag' then public.has_permission(organization_id, 'document.review_extraction')
      when 'status_change' then
           public.has_permission(organization_id, 'movement.write')
        or public.has_permission(organization_id, 'movement.transmit_to_customs')
        or public.has_permission(organization_id, 'movement.amend')
        or public.has_permission(organization_id, 'movement.cancel')
      else false
    end
  );

drop policy movement_amendments_update on public.movement_amendments;
create policy movement_amendments_update on public.movement_amendments for update to authenticated
  using (public.has_permission(organization_id, 'movement.transmit_to_customs'))
  with check (public.has_permission(organization_id, 'movement.transmit_to_customs'));

-- Only known producer permissions can enqueue user-originated jobs. Workers
-- retain unrestricted service-role access for retries and internal job types.
drop policy background_jobs_insert on public.background_jobs;
create policy background_jobs_insert on public.background_jobs for insert to authenticated
  with check (
    organization_id is not null and case job_type
      when 'customs.decide' then
        public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'compliance.scan' then public.has_permission(organization_id, 'alert.manage')
      when 'document.extract' then public.has_permission(organization_id, 'document.upload')
      when 'copilot.embed_knowledge' then case payload ->> 'sourceType'
        when 'movement_note' then public.has_permission(organization_id, 'movement.write')
        when 'hold_resolution' then public.has_permission(organization_id, 'alert.manage')
        when 'sop_document' then public.has_permission(organization_id, 'document.upload')
        else false
      end
      else false
    end
  );
