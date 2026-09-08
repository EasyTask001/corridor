-- =============================================================================
-- Corridor — 0022 manifest flags, CBSA amendment reason codes, customs event
-- vocabulary (Avaal parity gap 8)
--
--   1. movements: the ACE IIT indicator and the five ACI trip flags (LVS,
--      postal, flying truck, in transit, IIT).
--   2. movement_amendments: the CBSA ECCRD amendment reason code, required on
--      an ACI amendment, and the shipment an amendment is about.
--   3. movement_events gains the `customs_event` type — one row per message
--      the gateway sends back (sending, preliminary check, accepted, entry on
--      file per shipment, released, …) — and shipments may receive their entry
--      number after transmit.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. movements: manifest flags (same grain — columns)
-- -----------------------------------------------------------------------------

alter table public.movements
  -- Instruments of International Traffic: Avaal's three options.
  add column iit_indicator    text not null default 'none'
                                check (iit_indicator in ('none','iit_carrier_bond','iit_importer_bond')),
  -- CBSA ACI trip flags; meaningless (and kept false) on an ACE manifest.
  add column aci_lvs          boolean not null default false,
  add column aci_postal       boolean not null default false,
  add column aci_flying_truck boolean not null default false,
  add column aci_in_transit   boolean not null default false,
  add column aci_iit          boolean not null default false;

alter table public.movements
  add constraint movements_aci_flags_check
  check (regime = 'ACI'
         or not (aci_lvs or aci_postal or aci_flying_truck or aci_in_transit or aci_iit));

-- movements_guard() — live definition is 0021_equipment.sql (rebuilt there from
-- 0020 with trailer_id → is_empty). Rebuilt verbatim with the six flag terms
-- added to v_manifest_changed: a flag is manifest content and freezes with it.
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
    or new.port_id is distinct from old.port_id
    or new.carrier_code is distinct from old.carrier_code
    or new.scheduled_crossing_at is distinct from old.scheduled_crossing_at
    or new.truck_id is distinct from old.truck_id
    or new.is_empty is distinct from old.is_empty
    or new.iit_indicator is distinct from old.iit_indicator
    or new.aci_lvs is distinct from old.aci_lvs
    or new.aci_postal is distinct from old.aci_postal
    or new.aci_flying_truck is distinct from old.aci_flying_truck
    or new.aci_in_transit is distinct from old.aci_in_transit
    or new.aci_iit is distinct from old.aci_iit
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

-- -----------------------------------------------------------------------------
-- 2. movement_amendments: CBSA reason code, target shipment (same grain)
-- -----------------------------------------------------------------------------

alter table public.movement_amendments
  -- The shipment the amendment is about; null = the conveyance / trip header.
  add column shipment_id uuid references public.shipments(id) on delete set null,
  -- CBSA ECCRD chapter 7 amendment reason codes (conveyance 40/45/50/60/80/85,
  -- cargo 20/25/30/35/60/65/70/75/80/85). The canonical list with labels is
  -- CBSA_AMENDMENT_REASON_CODES in packages/domain.
  add column reason_code text
    check (reason_code in ('20','25','30','35','40','45','50','60','65','70','75','80','85'));

create index movement_amendments_shipment_idx on public.movement_amendments (shipment_id)
  where shipment_id is not null;

-- CBSA rejects an amendment without a reason; CBP does not use them.
create or replace function public.movement_amendments_reason_guard()
returns trigger
language plpgsql
as $$
declare
  v_regime text;
begin
  select regime into v_regime from public.movements where id = new.movement_id;
  if v_regime = 'ACI' and new.reason_code is null then
    raise exception 'an ACI amendment requires a CBSA reason code' using errcode = 'P0001';
  end if;
  if new.shipment_id is not null and not exists (
    select 1 from public.shipments s
    where s.id = new.shipment_id and s.movement_id = new.movement_id
  ) then
    raise exception 'amendment shipment is not on this movement' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger movement_amendments_reason_guard
  before insert or update on public.movement_amendments
  for each row execute function public.movement_amendments_reason_guard();

-- -----------------------------------------------------------------------------
-- 3. customs events on the timeline; entry numbers land after transmit
-- -----------------------------------------------------------------------------

alter table public.movement_events drop constraint movement_events_event_type_check;
alter table public.movement_events
  add constraint movement_events_event_type_check
  check (event_type in ('status_change','amendment','note','customs_response','ai_flag','customs_event'));

-- movement_events_insert — live definition is 0008_security_hardening.sql:190-205;
-- rebuilt with the customs_event arm (same permission as customs_response).
drop policy movement_events_insert on public.movement_events;
create policy movement_events_insert on public.movement_events for insert to authenticated
  with check (
    case event_type
      when 'note' then public.has_permission(organization_id, 'movement.write')
      when 'amendment' then public.has_permission(organization_id, 'movement.amend')
      when 'customs_response' then
        public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'customs_event' then
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

-- shipments_guard() — live definition is 0019_shipments.sql:229-316. Rebuilt
-- verbatim with entry_number / entry_port_id added to the columns that are not
-- frozen content: customs assigns them after transmit ("entry on file"), so
-- they must be writable while the movement is sent/accepted. Everything else
-- (identity immutability, re-assignment rules, regime match) is unchanged.
create or replace function public.shipments_guard()
returns trigger
language plpgsql
as $$
declare
  v_status text;
  v_regime text;
begin
  if tg_op = 'DELETE' then
    if old.movement_id is not null then
      select status into v_status from public.movements where id = old.movement_id;
      if found and not public.movement_is_editable(v_status) then
        raise exception 'movement is not editable in status %', v_status using errcode = 'P0001';
      end if;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.movement_id is not null then
      select regime, status into v_regime, v_status from public.movements where id = new.movement_id;
      if not found then
        raise exception 'movement % not found', new.movement_id using errcode = 'P0002';
      end if;
      if v_regime is distinct from new.regime then
        raise exception 'shipment regime % does not match movement regime %', new.regime, v_regime
          using errcode = 'P0001';
      end if;
      if not public.movement_is_editable(v_status) then
        raise exception 'movement is not editable in status %', v_status using errcode = 'P0001';
      end if;
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.regime is distinct from old.regime then
    raise exception 'shipment identity fields are immutable' using errcode = 'P0001';
  end if;

  if new.movement_id is distinct from old.movement_id then
    -- `on delete set null` fires this trigger for every shipment of a deleted
    -- draft movement; that detach is part of the delete, not a re-assignment.
    if new.movement_id is not null
       or exists (select 1 from public.movements where id = old.movement_id) then
      if old.status not in ('draft','rejected') then
        raise exception 'shipment % can only be re-assigned while draft or rejected', old.control_number
          using errcode = 'P0001';
      end if;
      if old.movement_id is not null then
        select status into v_status from public.movements where id = old.movement_id;
        if found and not public.movement_is_editable(v_status) then
          raise exception 'movement is not editable in status %', v_status using errcode = 'P0001';
        end if;
      end if;
      if new.movement_id is not null then
        select regime, status into v_regime, v_status from public.movements where id = new.movement_id;
        if not found then
          raise exception 'movement % not found', new.movement_id using errcode = 'P0002';
        end if;
        if v_regime is distinct from new.regime then
          raise exception 'shipment regime % does not match movement regime %', new.regime, v_regime
            using errcode = 'P0001';
        end if;
        if not public.movement_is_editable(v_status) then
          raise exception 'movement is not editable in status %', v_status using errcode = 'P0001';
        end if;
      end if;
    end if;
    return new;
  end if;

  -- Content edits (everything but the shipment's own lifecycle and the entry
  -- customs assigns to it) are frozen once the movement carrying it has been
  -- transmitted.
  if new.movement_id is not null
     and (to_jsonb(new) - 'status' - 'control_number' - 'entry_on_file_at' - 'released_at'
                        - 'arrived_at' - 'cancelled_at' - 'updated_at'
                        - 'entry_number' - 'entry_port_id')
         is distinct from
         (to_jsonb(old) - 'status' - 'control_number' - 'entry_on_file_at' - 'released_at'
                        - 'arrived_at' - 'cancelled_at' - 'updated_at'
                        - 'entry_number' - 'entry_port_id') then
    select status into v_status from public.movements where id = new.movement_id;
    if found and not public.movement_is_editable(v_status) then
      raise exception 'movement is not editable in status %', v_status using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;
