-- =============================================================================
-- Corridor — 0051 shipments.loaded_on: which unit a shipment rides on
--
--   Same grain as the shipment (a bill of lading rides on one physical unit),
--   so this is columns on shipments, not a new table. BorderConnect's
--   loadedOn field lets a filer say whether cargo is on the truck or a named
--   trailer, and defaults to "first trailer if one exists, else truck" when
--   omitted — the same default Corridor's own resolver applies. Null/null on
--   both columns means "unspecified": with zero or one trailer attached the
--   default is unambiguous; with more than one, the filer must choose (see
--   validateForTransmit / validateForBorderConnect, which refuse to guess).
-- =============================================================================

alter table public.shipments
  add column loaded_on_type text
    check (loaded_on_type in ('TRUCK', 'TRAILER')),
  -- References movement_trailers.id (a tow slot), never trailers.id — the
  -- same distinction seals.movement_trailer_id already makes.
  add column loaded_on_movement_trailer_id uuid,
  -- The id is present exactly when the type is TRAILER (`is not distinct
  -- from` so a null type also forces a null id).
  add constraint shipments_loaded_on_shape_check
    check (
      (loaded_on_type is not distinct from 'TRAILER')
      = (loaded_on_movement_trailer_id is not null)
    ),
  -- A placement only makes sense once the shipment is on a movement. This is
  -- normally guaranteed by shipments_loaded_on_guard (below), which clears
  -- both columns whenever movement_id changes; the check is defence in depth
  -- against any path that bypasses the trigger.
  add constraint shipments_loaded_on_requires_movement_check
    check (loaded_on_movement_trailer_id is null or movement_id is not null),
  -- Tenant-safe FK to the slot, same shape as seals_movement_trailer_org_fkey
  -- (which cascades a delete instead — dropping a trailer deletes its seals,
  -- but must not delete the shipment, only clear its placement). The
  -- column-list form of ON DELETE SET NULL is required here: on a composite
  -- FK, a bare `on delete set null` nulls *every* column in the key,
  -- including organization_id — exactly the shipments_import_batch_org_fkey /
  -- shipments_source_document_org_fkey pattern above in 0031. This does not
  -- by itself guarantee the slot is on *this* shipment's movement —
  -- shipments_loaded_on_guard enforces that, the same way seals_limit()
  -- enforces it for seals.movement_trailer_id.
  add constraint shipments_loaded_on_slot_fkey
    foreign key (loaded_on_movement_trailer_id, organization_id)
    references public.movement_trailers (id, organization_id)
    on delete set null (loaded_on_movement_trailer_id);

create index shipments_loaded_on_slot_idx
  on public.shipments (loaded_on_movement_trailer_id)
  where loaded_on_movement_trailer_id is not null;

-- Keeps the two loaded_on columns consistent across the three ways they can
-- change out from under a shipment:
--   1. the shipment is detached or moved to a different movement — the old
--      slot cannot belong to the new movement, so clear both columns;
--   2. the trailer slot itself is dropped from the tow — the FK's `on delete
--      set null` above nulls only the id, which would otherwise trip
--      shipments_loaded_on_shape_check, so normalise the type too;
--   3. an explicit write sets a TRAILER id — verify the slot is on this
--      shipment's own movement, exactly as seals_limit() does for seals.
-- Dropping a trailer or deleting a movement is itself only possible while
-- the movement is editable (movement_children_guard on movement_trailers,
-- shipments_guard's own movement_id-changed branch), so this trigger never
-- has to reconcile a placement against a frozen manifest.
create function public.shipments_loaded_on_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.movement_id is distinct from old.movement_id then
    new.loaded_on_type := null;
    new.loaded_on_movement_trailer_id := null;
    return new;
  end if;

  if new.loaded_on_type = 'TRAILER' and new.loaded_on_movement_trailer_id is null then
    new.loaded_on_type := null;
    return new;
  end if;

  if new.loaded_on_movement_trailer_id is not null and not exists (
    select 1 from public.movement_trailers mt
    where mt.id = new.loaded_on_movement_trailer_id
      and mt.movement_id = new.movement_id
  ) then
    raise exception 'shipment is loaded on a trailer that is not on this movement'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger shipments_loaded_on_guard
  before insert or update of movement_id, loaded_on_type, loaded_on_movement_trailer_id
  on public.shipments
  for each row execute function public.shipments_loaded_on_guard();
